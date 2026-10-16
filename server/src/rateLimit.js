'use strict';
/**
 * DB-backed login rate limiting.
 *
 * Replaces the previous in-memory Map so limits survive process restarts and
 * are shared across multiple instances of the API. Fixed window per key.
 */
const db = require('./db');

const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_PER_WINDOW = 40;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function getRecord(key) {
  const row = await db.q1('SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]);
  if (!row) return null;
  const resetAt = new Date(row.reset_at).getTime();
  if (resetAt < Date.now()) {
    await db.exec('DELETE FROM rate_limits WHERE key = ?', [key]);
    return null;
  }
  return { count: row.count, resetAt };
}

async function upsert(key, count, resetAt) {
  await db.exec(`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, reset_at = EXCLUDED.reset_at
  `, [key, count, new Date(resetAt).toISOString()]);
}

async function checkLoginRate(req, email) {
  const now = Date.now();
  const ipKey = clientIp(req);
  const ip = await getRecord(`ip:${ipKey}`);
  if (ip && ip.count >= IP_MAX_PER_WINDOW) {
    return 'Too many login attempts from this network. Please try again later.';
  }
  const key = `${ipKey}|${String(email || '').toLowerCase()}`;
  const rec = await getRecord(`login:${key}`);
  if (rec && rec.count >= LOGIN_MAX_FAILURES) {
    return 'Too many failed login attempts for this account. Please try again in 10 minutes.';
  }
  return null;
}

async function recordLoginFailure(req, email) {
  const now = Date.now();
  const ipKey = clientIp(req);
  const ipRec = await getRecord(`ip:${ipKey}`);
  const ipCount = (ipRec ? ipRec.count : 0) + 1;
  const ipReset = ipRec ? ipRec.resetAt : now + LOGIN_WINDOW_MS;
  await upsert(`ip:${ipKey}`, ipCount, ipReset);

  const key = `${ipKey}|${String(email || '').toLowerCase()}`;
  const rec = await getRecord(`login:${key}`);
  const count = (rec ? rec.count : 0) + 1;
  const reset = rec ? rec.resetAt : now + LOGIN_WINDOW_MS;
  await upsert(`login:${key}`, count, reset);
}

async function recordLoginSuccess(req, email) {
  const ipKey = clientIp(req);
  const key = `${ipKey}|${String(email || '').toLowerCase()}`;
  await db.exec('DELETE FROM rate_limits WHERE key = ?', [`login:${key}`]);
}

async function resetRateLimits() {
  await db.exec("DELETE FROM rate_limits WHERE key LIKE 'ip:%' OR key LIKE 'login:%'");
}

module.exports = {
  clientIp, checkLoginRate, recordLoginFailure, recordLoginSuccess, resetRateLimits,
  LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, IP_MAX_PER_WINDOW,
};
