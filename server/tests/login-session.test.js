'use strict';
/**
 * Login / session regression tests for the browser topology used in production:
 *  - the SPA and the API are on different origins (exact CORS allow-list, credentials)
 *  - the session cookie is HttpOnly + Secure + SameSite (production policy) + Path=/
 *  - 400 validation responses name the field but never echo or log secrets
 *  - unauthenticated bootstrap calls return a clean 401 with a diagnostic reason
 *
 * Run: node --test tests/login-session.test.js   (or npm test)
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('login_session');

// Production-like policy for this file (set BEFORE src/config is loaded).
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SAMESITE = 'lax';
process.env.COOKIE_SECURE = 'true';
process.env.CLIENT_ORIGIN = 'https://clinicportal.onrender.com,http://localhost:5173';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const A = require('../src/auth');

const SPA_ORIGIN = 'https://clinicportal.onrender.com';
const PASSWORD = 'Demo1234!';

let server;
let baseUrl;

test.before(async () => {
  await createTestDb();
  await seedMain();
  A.resetRateLimits();
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await destroyTestDb();
});

/** Capture console output from a block without polluting the test report. */
async function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    Object.assign(console, orig);
  }
}

function post(path, { headers = {}, body, raw } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

test('400: missing or empty email names the field, sets no cookie, and logs only field names', async () => {
  const { result: res, lines } = await captureConsole(() => post('/api/auth/login', {
    headers: JSON_HEADERS,
    body: { email: '', password: PASSWORD },
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'validation_error');
  assert.equal(body.error.fields.email, 'required');
  assert.equal(res.headers.get('set-cookie'), null);

  const diag = lines.find((l) => l.includes('[auth] login rejected'));
  assert.ok(diag, 'diagnostic line emitted');
  assert.match(diag, /email=required/);
  assert.match(diag, /content-type=application\/json/);
  assert.match(diag, /body-keys=email,password/);
  assert.ok(!diag.includes(PASSWORD), 'password must never be logged');
  assert.ok(!diag.includes('owner@alamal.demo'), 'email value must never be logged');
});

test('400: missing password is reported as password=required', async () => {
  const { result: res, lines } = await captureConsole(() => post('/api/auth/login', {
    headers: JSON_HEADERS,
    body: { email: 'owner@alamal.demo' },
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.fields.password, 'required');
  assert.ok(lines.some((l) => /password=required/.test(l)));
});

test('400: a form-encoded body (wrong Content-Type) is diagnosable from the log, not silently empty', async () => {
  const { result: res, lines } = await captureConsole(() => post('/api/auth/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    raw: 'email=owner%40alamal.demo&password=Demo1234%21',
  }));
  assert.equal(res.status, 400);
  const diag = lines.find((l) => l.includes('[auth] login rejected'));
  assert.ok(diag);
  assert.match(diag, /content-type=application\/x-www-form-urlencoded/);
  assert.match(diag, /body-keys=none/);
  assert.ok(!diag.includes('Demo1234'));
});

test('login success: cookie is HttpOnly, Secure, SameSite=Lax, Path=/, host-only (no Domain)', async () => {
  const res = await post('/api/auth/login', {
    headers: { ...JSON_HEADERS, Origin: SPA_ORIGIN },
    body: { email: 'owner@alamal.demo', password: PASSWORD },
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Set-Cookie present');
  assert.match(setCookie, /^cmp_token=/);
  assert.match(setCookie, /;\s*Path=\/(;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly/i);
  assert.match(setCookie, /;\s*Secure/i);
  assert.match(setCookie, /;\s*SameSite=Lax/i);
  assert.match(setCookie, /;\s*Max-Age=43200/i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i, 'cookie must stay host-only');
});

test('CORS: exact origin is echoed with credentials; unknown origin gets no allow header; never a wildcard', async () => {
  const preflight = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: SPA_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.ok(preflight.status === 204 || preflight.status === 200, `preflight status ${preflight.status}`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), SPA_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');

  const evil = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('CORS: the real POST from the SPA origin carries the exact allow-origin + credentials headers', async () => {
  const res = await post('/api/auth/login', {
    headers: { ...JSON_HEADERS, Origin: SPA_ORIGIN },
    body: { email: 'owner@alamal.demo', password: PASSWORD },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), SPA_ORIGIN);
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('origin guard: cross-site state-changing request from an unlisted origin is blocked', async () => {
  const res = await post('/api/auth/login', {
    headers: { ...JSON_HEADERS, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: { email: 'owner@alamal.demo', password: PASSWORD },
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.message, 'Cross-origin request blocked');
});

test('origin guard: a same-origin browser request (Sec-Fetch-Site) is allowed without an Origin header', async () => {
  const res = await post('/api/auth/login', {
    headers: { ...JSON_HEADERS, 'Sec-Fetch-Site': 'same-origin' },
    body: { email: 'owner@alamal.demo', password: PASSWORD },
  });
  assert.equal(res.status, 200);
});

test('bootstrap without a session cookie: clean 401, logged once with reason=no_session_cookie', async () => {
  const { result: res, lines } = await captureConsole(() => fetch(`${baseUrl}/api/meta/bootstrap`));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
  assert.ok(lines.some((l) => l.includes('GET /api/meta/bootstrap -> 401') && l.includes('reason=no_session_cookie')));
});

test('bootstrap with a tampered cookie: 401 with reason=token_invalid and no token echoed', async () => {
  const bogus = 'cmp_token=not.a.jwt';
  const { result: res, lines } = await captureConsole(() => fetch(`${baseUrl}/api/meta/bootstrap`, { headers: { Cookie: bogus } }));
  assert.equal(res.status, 401);
  const line = lines.find((l) => l.includes('GET /api/meta/bootstrap -> 401'));
  assert.ok(line && line.includes('reason=token_invalid'));
  assert.ok(!line.includes('not.a.jwt'));
});

test('session lifecycle: login -> bootstrap 200 with cookie -> logout -> bootstrap 401 again', async () => {
  const login = await post('/api/auth/login', {
    headers: { ...JSON_HEADERS, Origin: SPA_ORIGIN },
    body: { email: 'owner@alamal.demo', password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const boot = await fetch(`${baseUrl}/api/meta/bootstrap`, { headers: { Cookie: cookie, Origin: SPA_ORIGIN } });
  assert.equal(boot.status, 200);
  assert.equal((await boot.json()).user.email, 'owner@alamal.demo');

  const out = await post('/api/auth/logout', { headers: { Cookie: cookie, Origin: SPA_ORIGIN } });
  assert.equal(out.status, 200);

  const after = await fetch(`${baseUrl}/api/meta/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, 'logout revokes the session server-side');
});
