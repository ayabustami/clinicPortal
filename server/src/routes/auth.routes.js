'use strict';
const router = require('express').Router();
const db = require('../db');
const { asyncH, badRequest, unauthorized, ApiError } = require('../util/errors');
const V = require('../util/validate');
const A = require('../auth');
const { audit } = require('../util/audit');

// POST /api/auth/login — rate limited, timing-equalized
router.post('/login', asyncH(async (req, res) => {
  const body = req.body || {};
  let email;
  try {
    email = V.email(body.email, 'email', { required: true });
  } catch (e) {
    // still count toward IP rate to blunt spraying with garbage payloads
    A.recordLoginFailure(req, '');
    throw e;
  }
  const password = V.str(body.password, 'password', { required: true, max: 200 });

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

// POST /api/auth/change-password — verifies the current password, rotates sessions
router.post('/change-password', A.requireAuth, asyncH(async (req, res) => {
  const body = req.body || {};
  const current = V.str(body.current_password, 'current_password', { required: true, max: 200 });
  const nextPw = V.str(body.new_password, 'new_password', { required: true, max: 200 });
  if (nextPw.length < 8) throw badRequest('New password must be at least 8 characters');
  if (nextPw === current) throw badRequest('New password must be different from the current password');

  const user = await db.q1('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!A.verifyPassword(current, user.password_hash)) {
    await audit(db, { clinicId: user.clinic_id, userId: user.id, action: 'auth.password_change.failed', entity: 'user', entityId: user.id });
    throw badRequest('Current password is incorrect');
  }

  await db.withTx(async (t) => {
    await t.exec('UPDATE users SET password_hash = ? WHERE id = ?', [A.hashPassword(nextPw), user.id]);
    await A.bumpTokenVersion(t, user.id); // revoke all existing sessions (policy)
    await audit(t, { clinicId: user.clinic_id, userId: user.id, action: 'auth.password_change', entity: 'user', entityId: user.id });
  });

  // Keep the CURRENT session alive by issuing a fresh token with the new version.
  const fresh = await db.q1('SELECT * FROM users WHERE id = ?', [user.id]);
  A.setAuthCookie(res, A.signToken(fresh));
  res.json({ ok: true });
}));

module.exports = router;
