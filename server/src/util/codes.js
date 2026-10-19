'use strict';
/**
 * One-time email verification codes (password reset / change / account setup).
 *
 * - Codes are 6 random digits (crypto.randomInt), stored ONLY as SHA-256
 *   hashes of `purpose:code` — plaintext never touches the database.
 * - Single-use: successful verification marks the row consumed.
 * - Bounded guessing: each verify attempt increments `attempts`; after
 *   MAX_ATTEMPTS the code is dead.
 * - Short TTL (15 minutes).
 * - `exposeDevCode()` decides whether the raw code may be echoed in an API
 *   response (development/test convenience). Production stays closed unless
 *   the operator explicitly opts in with EMAIL_DEV_EXPOSE_CODES=YES (demo
 *   deployments without a mail provider).
 */
const crypto = require('crypto');
const { nowIso } = require('./time');

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;

function hashCode(code, purpose) {
  return crypto.createHash('sha256').update(`${purpose}:${String(code || '')}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** May the API response include the raw code? (never in production by default) */
function exposeDevCode() {
  const env = process.env.NODE_ENV || 'development';
  return env !== 'production' || process.env.EMAIL_DEV_EXPOSE_CODES === 'YES';
}

/** Mask an email for display ("m***@example.com"). */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  return `${user[0]}${'*'.repeat(Math.max(1, Math.min(4, user.length - 1)))}@${domain}`;
}

/**
 * Issue a fresh code for (email, purpose). Any previous unconsumed code for
 * the same email (ANY purpose) is invalidated first — at most one live code
 * per person keeps verification unambiguous and bounds guessing attempts.
 * Returns { code, id, expiresAt } — the plaintext `code` is for the email/dev
 * response only.
 */
async function issueCode(runner, { userId = null, email, purpose }) {
  await runner.exec(
    `UPDATE email_verification_codes SET consumed_at = ?
     WHERE lower(email) = lower(?) AND consumed_at IS NULL`,
    [nowIso(), email]
  );
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString();
  const row = await runner.q1(
    `INSERT INTO email_verification_codes (user_id, email, purpose, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [userId, email, purpose, hashCode(code, purpose), expiresAt]
  );
  return { id: row.id, code, expiresAt };
}

/**
 * Verify a code for (email, purposes). Consumes it on success.
 * Returns the code row on success, null otherwise (wrong / expired /
 * exhausted / unknown) — callers must collapse all of those into one message.
 */
async function verifyCode(runner, { email, purposes, code }) {
  const list = Array.isArray(purposes) ? purposes : [purposes];
  const row = await runner.q1(
    `SELECT * FROM email_verification_codes
     WHERE lower(email) = lower(?) AND purpose IN (${list.map(() => '?').join(',')})
       AND consumed_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [email, ...list]
  );
  if (!row) return null;
  if (row.attempts >= MAX_ATTEMPTS) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Every try counts — including the successful one (the row is consumed anyway).
  await runner.exec('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  if (!safeEqualHex(row.code_hash, hashCode(code, row.purpose))) return null;
  await runner.exec('UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row;
}

module.exports = {
  issueCode, verifyCode, exposeDevCode, maskEmail,
  CODE_TTL_MIN, MAX_ATTEMPTS,
};
