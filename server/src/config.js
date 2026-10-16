'use strict';
require('dotenv').config();
const path = require('path');

const DEV_SECRET = 'dev-only-secret-change-me';

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  jwtSecret: process.env.JWT_SECRET || DEV_SECRET,
  /**
   * PostgreSQL connection string (Neon in production). REQUIRED — there is no
   * hardcoded fallback with credentials. Set it in server/.env (git-ignored).
   * The legacy SQLite path is kept ONLY for the import/backup scripts.
   */
  databaseUrl: process.env.DATABASE_URL || '',
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || '10', 10),
  sqlitePath: process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'clinic-portal.db'),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  tokenTtl: process.env.TOKEN_TTL || '12h',
  /**
   * Auth cookie policy.
   * - production: SameSite=Lax (CSRF-safe default; use COOKIE_SAMESITE=none only
   *   if the app must run embedded in a cross-site iframe, behind HTTPS).
   * - development: SameSite=None + Secure so sandboxed HTTPS previews (which
   *   embed the app in a cross-origin iframe) can keep the session cookie.
   *   Browsers accept Secure cookies on http://localhost (trustworthy origin).
   */
  cookieSameSite: (process.env.COOKIE_SAMESITE ||
    ((process.env.NODE_ENV || 'development') === 'production' ? 'lax' : 'none')).toLowerCase(),
  cookieSecure: process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === 'true' : true,
};

if (!['lax', 'strict', 'none'].includes(config.cookieSameSite)) {
  console.error('[config] COOKIE_SAMESITE must be one of: lax, strict, none');
  process.exit(1);
}
if (config.cookieSameSite === 'none' && !config.cookieSecure) {
  // Browsers reject SameSite=None without Secure — enforce the pairing.
  console.warn('[config] SameSite=None requires Secure; forcing COOKIE_SECURE=true');
  config.cookieSecure = true;
}

/**
 * Production fail-fast: refuse to start with insecure or missing configuration.
 * Development stays convenient (works without any .env).
 */
if (config.env === 'production') {
  const problems = [];
  if (!config.databaseUrl) {
    problems.push('DATABASE_URL must be set to the PostgreSQL (Neon) connection string');
  }
  if (!process.env.JWT_SECRET || config.jwtSecret === DEV_SECRET) {
    problems.push('JWT_SECRET must be set to a strong random value (generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))")');
  } else if (config.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters long');
  }
  if (problems.length) {
    console.error('[config] Refusing to start in production with insecure configuration:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

module.exports = config;
