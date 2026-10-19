'use strict';
/**
 * Email verification-code flows (node:test + fetch) against a real server
 * instance backed by a throwaway PostgreSQL database seeded with the demo
 * fixture:
 *   - forgot-password (enumeration-safe) + reset-password
 *   - change-password requires an emailed code (request-code)
 *   - account-setup invitations when an owner/admin adds a staff account
 *   - throttling of code requests
 *
 * NODE_ENV=test exposes dev_code in API responses (same as development).
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('pwreset');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;

let server;
let baseUrl;

function makeClient() {
  let cookie = null;
  const client = {
    getCookie: () => cookie,
    async req(method, urlPath, body, opts = {}) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(opts.body ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {}),
          ...(cookie ? { cookie } : {}),
        },
        body: opts.body !== undefined ? opts.body : (body === undefined ? undefined : JSON.stringify(body)),
      });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, data, text, headers: res.headers };
    },
    get: (p) => client.req('GET', p),
    post: (p, b) => client.req('POST', p, b),
    put: (p, b) => client.req('PUT', p, b),
    patch: (p, b) => client.req('PATCH', p, b),
    del: (p) => client.req('DELETE', p),
  };
  return client;
}

async function login(email, password = 'Demo1234!') {
  const c = makeClient();
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, `login ${email} failed: ${r.text}`);
  return c;
}

function otherCode(code) {
  return code === '999999' ? '000000' : '999999';
}

test.before(async () => {
  await createTestDb();
  await seedMain();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await destroyTestDb();
});

test('forgot-password: unknown email returns the same ok response and sends nothing', async () => {
  const c = makeClient();
  const r = await c.post('/api/auth/forgot-password', { email: 'nobody@nowhere.demo' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dev_code, undefined, 'no code may exist for unknown accounts');
});

test('forgot/reset: code resets the password and revokes every session', async () => {
  const { resetRateLimits } = require('../src/auth');
  resetRateLimits();
  const c = makeClient();
  const forgot = await c.post('/api/auth/forgot-password', { email: 'omar@alamal.demo' });
  assert.equal(forgot.status, 200, forgot.text);
  assert.equal(forgot.data.ok, true);
  assert.ok(/^\d{6}$/.test(forgot.data.dev_code || ''), 'dev/test responses expose the 6-digit code');

  const wrong = await c.post('/api/auth/reset-password', {
    email: 'omar@alamal.demo', code: otherCode(forgot.data.dev_code), new_password: 'ResetPass1!',
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error.message, /invalid or expired/i);

  // live session before the reset
  const omar = await login('omar@alamal.demo');

  const ok = await c.post('/api/auth/reset-password', {
    email: 'omar@alamal.demo', code: forgot.data.dev_code, new_password: 'ResetPass1!',
  });
  assert.equal(ok.status, 200, ok.text);

  // old session is revoked; old password is dead; new password works
  assert.equal((await omar.get('/api/auth/me')).status, 401);
  const oldPw = makeClient();
  assert.equal((await oldPw.post('/api/auth/login', { email: 'omar@alamal.demo', password: 'Demo1234!' })).status, 401);
  await login('omar@alamal.demo', 'ResetPass1!'); // throws if the new password is rejected

  // the code is single-use
  const replay = await c.post('/api/auth/reset-password', {
    email: 'omar@alamal.demo', code: forgot.data.dev_code, new_password: 'Another123!',
  });
  assert.equal(replay.status, 400);

  // restore the demo password for later tests in this file
  resetRateLimits();
  const back = await c.post('/api/auth/forgot-password', { email: 'omar@alamal.demo' });
  const restore = await c.post('/api/auth/reset-password', {
    email: 'omar@alamal.demo', code: back.data.dev_code, new_password: 'Demo1234!',
  });
  assert.equal(restore.status, 200);
});

test('forgot-password: requests are throttled per email', async () => {
  const { resetRateLimits } = require('../src/auth');
  resetRateLimits();
  const c = makeClient();
  const first = await c.post('/api/auth/forgot-password', { email: 'reception@alamal.demo' });
  assert.equal(first.status, 200);
  const second = await c.post('/api/auth/forgot-password', { email: 'reception@alamal.demo' });
  assert.equal(second.status, 429);
  resetRateLimits();
});

test('change-password: requires a valid emailed code; wrong code rejected', async () => {
  const { resetRateLimits } = require('../src/auth');
  resetRateLimits();
  const owner = await login('owner@alamal.demo');

  // no code at all
  const noCode = await owner.post('/api/auth/change-password', { current_password: 'Demo1234!', new_password: 'BrandNew123!' });
  assert.equal(noCode.status, 400);

  const send = await owner.post('/api/auth/change-password/request-code', {});
  assert.equal(send.status, 200, send.text);
  assert.equal(send.data.ok, true);
  assert.ok(/^\d{6}$/.test(send.data.dev_code || ''));

  // wrong code
  const wrong = await owner.post('/api/auth/change-password', {
    current_password: 'Demo1234!', new_password: 'BrandNew123!', code: otherCode(send.data.dev_code),
  });
  assert.equal(wrong.status, 400);

  // wrong current password with the RIGHT code -> rejected before the code is consumed
  const badCurrent = await owner.post('/api/auth/change-password', {
    current_password: 'WrongPass1!', new_password: 'BrandNew123!', code: send.data.dev_code,
  });
  assert.equal(badCurrent.status, 400);

  // success (code still valid because the previous attempt never reached verification)
  const ok = await owner.post('/api/auth/change-password', {
    current_password: 'Demo1234!', new_password: 'BrandNew123!', code: send.data.dev_code,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await owner.get('/api/auth/me')).status, 200, 'current session is re-issued');

  // restore
  const send2 = await owner.post('/api/auth/change-password/request-code', {});
  const restore = await owner.post('/api/auth/change-password', {
    current_password: 'BrandNew123!', new_password: 'Demo1234!', code: send2.data.dev_code,
  });
  assert.equal(restore.status, 200);
  resetRateLimits();
});

test('staff creation: account-setup invitation carries a working one-time code', async () => {
  const { resetRateLimits } = require('../src/auth');
  resetRateLimits();
  const owner = await login('owner@alamal.demo');
  const created = await owner.post('/api/staff/users', {
    full_name: 'New Hire', email: 'newhire@alamal.demo', password: 'Welcome123!', role: 'receptionist',
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.invite.sent, true);
  assert.ok(/^\d{6}$/.test(created.data.invite.dev_code || ''), 'invitation exposes the setup code outside production');

  // the setup code verifies the email and sets their own password
  const reset = await makeClient().post('/api/auth/reset-password', {
    email: 'newhire@alamal.demo', code: created.data.invite.dev_code, new_password: 'Chosen123!',
  });
  assert.equal(reset.status, 200, reset.text);
  await login('newhire@alamal.demo', 'Chosen123!'); // throws if the new password is rejected
  // the original temporary password no longer works
  const dead = makeClient();
  assert.equal((await dead.post('/api/auth/login', { email: 'newhire@alamal.demo', password: 'Welcome123!' })).status, 401);
  resetRateLimits();
});
