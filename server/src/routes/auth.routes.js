'use strict';
const router = require('express').Router();
const db = require('../db');
const { asyncH, badRequest, unauthorized, ApiError } = require('../util/errors');
const V = require('../util/validate');
const A = require('../auth');
const { audit } = require('../util/audit');
const { issueCode, verifyCode, exposeDevCode, maskEmail } = require('../util/codes');
const { sendVerificationEmail } = require('../services/email');

/**
 * Diagnostic line for a rejected login payload. Logs only the failing field,
 * the validation code, the request Content-Type and the NAMES of the body keys
 * — never the email or password values.
 */
function logValidationReject(req, err) {
  if (!err || !err.fields) return;
  const fields = Object.entries(err.fields).map(([f, code]) => `${f}=${code}`).join(',');
  const contentType = String(req.headers['content-type'] || 'none').split(';')[0].trim();
  const keys = Object.keys(req.body || {}).join(',') || 'none';
  console.warn(`[auth] login rejected: ${fields} content-type=${contentType} body-keys=${keys}`);
}

// POST /api/auth/login — rate limited, timing-equalized
router.post('/login', asyncH(async (req, res) => {
  const body = req.body || {};
  let email;
  try {
    email = V.email(body.email, 'email', { required: true });
  } catch (e) {
    // still count toward IP rate to blunt spraying with garbage payloads
    A.recordLoginFailure(req, '');
    logValidationReject(req, e);
    throw e;
  }
  let password;
  try {
    password = V.str(body.password, 'password', { required: true, max: 200 });
  } catch (e) {
    logValidationReject(req, e);
    throw e;
  }

  const blocked = A.checkLoginRate(req, email);
  if (blocked) throw new ApiError(429, blocked, 'rate_limited');

  // lower() matches the previous SQLite COLLATE NOCASE behavior
  const user = await db.q1('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  const ok = A.verifyPasswordSafe(password, user); // always runs a bcrypt compare

  if (!user || !ok) {
    A.recordLoginFailure(req, email);
    // Note: we never log the password or the attempted password.
    await audit(db, { clinicId: user ? user.clinic_id : null, userId: user ? user.id : null,
      action: 'auth.login.failed', entity: 'user', entityId: user ? user.id : null,
      details: { email: user ? undefined : 'unknown-account' } });
    throw unauthorized('Incorrect email or password');
  }
  if (!user.is_active) throw unauthorized('This account has been deactivated');
  if (user.clinic_id) {
    const clinic = await db.q1('SELECT status FROM clinics WHERE id = ?', [user.clinic_id]);
    if (!clinic || clinic.status !== 'active') throw unauthorized('This clinic account is suspended');
  }

  A.recordLoginSuccess(req, email);
  const token = A.signToken(user);
  A.setAuthCookie(res, token);
  await audit(db, { clinicId: user.clinic_id, userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id });
  res.json({ user: A.publicUser(user) });
}));

// POST /api/auth/forgot-password — always succeeds (no account enumeration);
// when the account exists, a one-time verification code is emailed.
router.post('/forgot-password', asyncH(async (req, res) => {
  const body = req.body || {};
  let email;
  try {
    email = V.email(body.email, 'email', { required: true });
  } catch (e) {
    A.recordOtpIp(req); // blunt garbage-payload spraying
    throw e;
  }
  const blocked = A.checkCodeSendRate(req, email, 'password_reset');
  if (blocked) throw new ApiError(429, blocked, 'rate_limited');
  A.recordCodeSend(req, email, 'password_reset');

  const user = await db.q1('SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1', [email]);
  let devCode;
  if (user) {
    const { code } = await issueCode(db, { userId: user.id, email: user.email, purpose: 'password_reset' });
    const sent = await sendVerificationEmail({
      to: user.email, code, purpose: 'password_reset', name: user.full_name,
    });
    if (!sent) console.error(`[auth] password-reset email could not be delivered to ${maskEmail(user.email)}`);
    if (exposeDevCode()) devCode = code;
    await audit(db, { clinicId: user.clinic_id, userId: user.id,
      action: 'auth.password_reset.requested', entity: 'user', entityId: user.id });
  }
  // Identical response whether or not the account exists.
  res.json({ ok: true, sent_to: maskEmail(email), ...(devCode ? { dev_code: devCode } : {}) });
}));

// POST /api/auth/reset-password — consume a password_reset/account_setup code
// and set the new password. All invalid states collapse to one error message.
router.post('/reset-password', asyncH(async (req, res) => {
  const body = req.body || {};
  const email = V.email(body.email, 'email', { required: true });
  const code = V.str(body.code, 'code', { required: true, max: 12 });
  const password = V.str(body.new_password, 'new_password', { required: true, max: 200 });
  if (password.length < 8) throw badRequest('Password must be at least 8 characters');

  const ipBlocked = A.checkOtpIpRate(req);
  if (ipBlocked) throw new ApiError(429, ipBlocked, 'rate_limited');
  A.recordOtpIp(req);

  // Verification runs outside the write transaction on purpose: the bounded
  // attempt counter must survive a rollback when the code is wrong.
  const row = await verifyCode(db, { email, purposes: ['password_reset', 'account_setup'], code });
  if (!row) throw badRequest('Invalid or expired verification code');

  const user = row.user_id ? await db.q1('SELECT * FROM users WHERE id = ?', [row.user_id]) : null;
  if (!user || !user.is_active) throw badRequest('Invalid or expired verification code');

  await db.withTx(async (t) => {
    await t.exec('UPDATE users SET password_hash = ? WHERE id = ?', [A.hashPassword(password), user.id]);
    await A.bumpTokenVersion(t, user.id); // every existing session is revoked
    await audit(t, { clinicId: user.clinic_id, userId: user.id,
      action: row.purpose === 'account_setup' ? 'auth.account_setup' : 'auth.password_reset',
      entity: 'user', entityId: user.id });
  });
  A.clearCodeSend(email, 'password_reset');
  A.clearCodeSend(email, 'account_setup');
  res.json({ ok: true });
}));

// POST /api/auth/logout — clears the cookie AND revokes the session server-side
router.post('/logout', asyncH(async (req, res) => {
  const token = req.cookies ? req.cookies[A.COOKIE_NAME] : null;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const config = require('../config');
      const payload = jwt.verify(token, config.jwtSecret);
      await A.bumpTokenVersion(db, payload.sub);
      await audit(db, { clinicId: payload.clinic_id, userId: payload.sub, action: 'auth.logout', entity: 'user', entityId: payload.sub });
    } catch {
      /* invalid/expired token — nothing to revoke */
    }
  }
  A.clearAuthCookie(res);
  res.json({ ok: true });
}));

// GET /api/auth/me
router.get('/me', A.requireAuth, (req, res) => {
  res.json({ user: A.publicUser(req.user) });
});

// POST /api/auth/change-password/request-code — email a one-time code that
// confirms the account owner before a password change is accepted.
router.post('/change-password/request-code', A.requireAuth, asyncH(async (req, res) => {
  const email = req.user.email;
  const blocked = A.checkCodeSendRate(req, email, 'password_change');
  if (blocked) throw new ApiError(429, blocked, 'rate_limited');
  A.recordCodeSend(req, email, 'password_change');

  const { code } = await issueCode(db, { userId: req.user.id, email, purpose: 'password_change' });
  const sent = await sendVerificationEmail({
    to: email, code, purpose: 'password_change', name: req.user.full_name,
  });
  if (!sent) console.error(`[auth] password-change email could not be delivered to ${maskEmail(email)}`);
  await audit(db, { clinicId: req.user.clinic_id, userId: req.user.id,
    action: 'auth.password_change.code_sent', entity: 'user', entityId: req.user.id });
  res.json({ ok: true, sent_to: maskEmail(email), ...(exposeDevCode() ? { dev_code: code } : {}) });
}));

// POST /api/auth/change-password — current password AND an emailed one-time
// code (verified ownership of the account email), then rotates all sessions.
router.post('/change-password', A.requireAuth, asyncH(async (req, res) => {
  const body = req.body || {};
  const current = V.str(body.current_password, 'current_password', { required: true, max: 200 });
  const nextPw = V.str(body.new_password, 'new_password', { required: true, max: 200 });
  const code = V.str(body.code, 'code', { required: true, max: 12 });
  if (nextPw.length < 8) throw badRequest('New password must be at least 8 characters');
  if (nextPw === current) throw badRequest('New password must be different from the current password');

  const user = await db.q1('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!A.verifyPassword(current, user.password_hash)) {
    await audit(db, { clinicId: user.clinic_id, userId: user.id, action: 'auth.password_change.failed', entity: 'user', entityId: user.id });
    throw badRequest('Current password is incorrect');
  }

  // Verify outside the write transaction so the bounded attempt counter
  // survives a rollback when the code is wrong.
  const row = await verifyCode(db, { email: user.email, purposes: ['password_change'], code });
  if (!row) throw badRequest('Invalid or expired verification code');

  await db.withTx(async (t) => {
    await t.exec('UPDATE users SET password_hash = ? WHERE id = ?', [A.hashPassword(nextPw), user.id]);
    await A.bumpTokenVersion(t, user.id); // revoke all existing sessions (policy)
    await audit(t, { clinicId: user.clinic_id, userId: user.id, action: 'auth.password_change', entity: 'user', entityId: user.id });
  });
  A.clearCodeSend(user.email, 'password_change');

  // Keep the CURRENT session alive by issuing a fresh token with the new version.
  const fresh = await db.q1('SELECT * FROM users WHERE id = ?', [user.id]);
  A.setAuthCookie(res, A.signToken(fresh));
  res.json({ ok: true });
}));

module.exports = router;
