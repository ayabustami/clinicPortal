'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { q1, exec } = require('./db');
const { unauthorized, forbidden } = require('./util/errors');

const COOKIE_NAME = 'cmp_token';
const HASH_ROUNDS = 10;

/** Precomputed dummy hash so login timing does not reveal whether an account exists. */
const DUMMY_HASH = bcrypt.hashSync('cmp-timing-equalizer-dummy', HASH_ROUNDS);

/**
 * Central role-permission matrix. Routes must use these lists (or requireRole)
 * so authorization stays consistent across the API. platform_admin passes
 * requireRole checks but is blocked from clinic-scoped routes by requireClinic.
 */
const PERMS = {
  financial: ['owner', 'accountant'],            // payments, refunds, revenue, financial dashboard fields
  financial_view: ['owner', 'accountant', 'receptionist'], // aggregated patient balance status only (no invoice records)
  invoice_create: ['owner', 'accountant', 'doctor'], // doctors invoice their performed work; price edits locked once paid
  invoice_read: ['owner', 'accountant', 'doctor'],
  clinical: ['owner', 'doctor'],                 // medical records read/write, clinical flags
  scheduling: ['owner', 'receptionist', 'doctor'], // appointment create/edit/status
  patient_registration: ['owner', 'receptionist'],
  staff_admin: ['owner'],
  settings_admin: ['owner'],
  audit_view: ['owner'],                         // clinic audit trail
  reports_appointments: ['owner', 'receptionist', 'accountant'],
};

/* ---------------- passwords ---------------- */

function hashPassword(plain) {
  return bcrypt.hashSync(plain, HASH_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/** Always run a bcrypt compare, even for unknown emails (account-enumeration timing defense). */
function verifyPasswordSafe(plain, user) {
  return bcrypt.compareSync(plain, user ? user.password_hash : DUMMY_HASH);
}

/* ---------------- tokens & sessions ---------------- */

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, clinic_id: user.clinic_id, tv: user.token_version || 1 },
    config.jwtSecret,
    { expiresIn: config.tokenTtl }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  // Attributes must match the ones used at set-time for the browser to delete it.
  res.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
  });
}

/** Revoke every session for a user (password change, logout, deactivation). */
async function bumpTokenVersion(t, userId) {
  await t.exec('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
}

/** Require a valid, non-revoked session belonging to an active user in an active clinic. */
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    // res.locals.authReason is a fixed diagnostic code for the request log
    // (no token, cookie or user data). It never changes the response body.
    if (!token) {
      res.locals.authReason = 'no_session_cookie';
      return next(unauthorized());
    }
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      res.locals.authReason = err && err.name === 'TokenExpiredError' ? 'token_expired' : 'token_invalid';
      return next(unauthorized('Session expired, please sign in again'));
    }
    // Single round trip: user + clinic in one join. This runs on EVERY API
    // request, so on latency-sensitive deployments the second sequential
    // lookup was pure added RTT. Clinic columns are aliased to avoid
    // colliding with users.* (both tables have id/name/status/created_at...).
    const row = await q1(`
      SELECT u.*,
             c.id            AS c_id,
             c.name          AS c_name,
             c.slug          AS c_slug,
             c.email         AS c_email,
             c.phone         AS c_phone,
             c.address       AS c_address,
             c.timezone      AS c_timezone,
             c.slot_minutes  AS c_slot_minutes,
             c.working_hours AS c_working_hours,
             c.currency      AS c_currency,
             c.status        AS c_status,
             c.created_at    AS c_created_at
      FROM users u
      LEFT JOIN clinics c ON c.id = u.clinic_id
      WHERE u.id = ?`, [payload.sub]);
    if (!row || !row.is_active) {
      res.locals.authReason = 'account_disabled';
      return next(unauthorized('Your account is disabled'));
    }
    // Session revocation: token must carry the current token_version.
    if (payload.tv !== (row.token_version || 1)) {
      res.locals.authReason = 'session_revoked';
      return next(unauthorized('This session has been revoked, please sign in again'));
    }
    const user = {};
    for (const [k, v] of Object.entries(row)) if (!k.startsWith('c_')) user[k] = v;
    const clinic = row.c_id ? {
      id: row.c_id, name: row.c_name, slug: row.c_slug, email: row.c_email,
      phone: row.c_phone, address: row.c_address, timezone: row.c_timezone,
      slot_minutes: row.c_slot_minutes, working_hours: row.c_working_hours,
      currency: row.c_currency, status: row.c_status, created_at: row.c_created_at,
    } : null;
    if (user.clinic_id && (!clinic || clinic.status !== 'active')) {
      return next(forbidden('This clinic account is suspended'));
    }
    req.user = user;
    req.clinic = clinic;
    next();
  } catch (err) {
    next(err);
  }
}

/** Restrict a route to specific roles. Platform admins pass every check. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'platform_admin') return next();
    if (!roles.includes(req.user.role)) {
      return next(forbidden());
    }
    next();
  };
}

/** Require a clinic-scoped user (rejects platform admins on clinic-only routes). */
function requireClinic(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.clinic_id) return next(forbidden('Platform admins must select a clinic context'));
  next();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    clinic_id: user.clinic_id,
    phone: user.phone,
    is_active: !!user.is_active,
  };
}

/* ---------------- login rate limiting (in-memory, fixed window) ---------------- */

const loginAttempts = new Map(); // key -> { count, resetAt }
const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_PER_WINDOW = 40;
const ipAttempts = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Returns an error message when the attempt should be blocked, else null. */
function checkLoginRate(req, email) {
  const now = Date.now();
  const ipKey = clientIp(req);
  const ip = ipAttempts.get(ipKey);
  if (ip && ip.resetAt < now) ipAttempts.delete(ipKey);
  if (ip && ip.count >= IP_MAX_PER_WINDOW) {
    return 'Too many login attempts from this network. Please try again later.';
  }
  const key = `${ipKey}|${String(email || '').toLowerCase()}`;
  const rec = loginAttempts.get(key);
  if (rec && rec.resetAt < now) loginAttempts.delete(key);
  if (rec && rec.count >= LOGIN_MAX_FAILURES) {
    return 'Too many failed login attempts for this account. Please try again in 10 minutes.';
  }
  return null;
}

function recordLoginFailure(req, email) {
  const now = Date.now();
  const ipKey = clientIp(req);
  const ip = ipAttempts.get(ipKey) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  ip.count += 1;
  ipAttempts.set(ipKey, ip);
  const key = `${ipKey}|${String(email || '').toLowerCase()}`;
  const rec = loginAttempts.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  rec.count += 1;
  loginAttempts.set(key, rec);
}

function recordLoginSuccess(req, email) {
  const key = `${clientIp(req)}|${String(email || '').toLowerCase()}`;
  loginAttempts.delete(key);
}

/** For tests and process reuse. */
function resetRateLimits() {
  loginAttempts.clear();
  ipAttempts.clear();
}

/* ---------------- CSRF / origin defense for cookie-auth requests ---------------- */

function allowedOrigins(req) {
  const list = new Set();
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  if (req.headers.host) list.add(`${proto}://${req.headers.host}`);
  if (config.clientOrigin) {
    for (const o of String(config.clientOrigin).split(',')) list.add(o.trim().replace(/\/$/, ''));
  }
  return list;
}

/**
 * Reject cross-site state-changing requests: if a browser sends an Origin (or
 * Sec-Fetch-Site cross-site) header that is not an allowed origin, block it.
 * Non-browser clients (no Origin header) are unaffected; SameSite=Lax cookie is
 * the second line of defense.
 */
function originGuard(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe) return next();
  const origin = req.headers.origin;
  const secSite = req.headers['sec-fetch-site'];
  if (!origin && !secSite) return next(); // non-browser client
  // Sec-Fetch-Site is set by the browser itself and is a forbidden header name,
  // so page JavaScript cannot spoof it. "same-origin" (and "none" = user-initiated
  // navigation/bookmark) are therefore trusted; everything else must match the
  // explicit Origin allowlist (HOST-based + CLIENT_ORIGIN env).
  if (secSite === 'same-origin' || secSite === 'none') return next();
  if (origin && allowedOrigins(req).has(origin.replace(/\/$/, ''))) return next();
  return next(forbidden('Cross-origin request blocked'));
}

/** Random URL-safe id (storage names, references). */
function randomId() {
  return crypto.randomUUID();
}

module.exports = {
  COOKIE_NAME, PERMS, HASH_ROUNDS,
  hashPassword, verifyPassword, verifyPasswordSafe,
  signToken, setAuthCookie, clearAuthCookie, bumpTokenVersion,
  requireAuth, requireRole, requireClinic, publicUser,
  checkLoginRate, recordLoginFailure, recordLoginSuccess, resetRateLimits,
  originGuard, clientIp, randomId,
};
