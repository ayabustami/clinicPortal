'use strict';
/**
 * Unit tests for the outbound-email configuration diagnostics.
 *
 * These run without a database or network: they only assert that a missing or
 * broken provider is reported honestly instead of silently pretending email
 * works (the production bug behind "the reset code never arrived").
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const {
  emailStatus, undeliverableReason, sendMail,
} = require('../src/services/email');

const KEYS = [
  'EMAIL_TRANSPORT', 'EMAIL_HTTP_URL', 'EMAIL_HTTP_API_KEY', 'EMAIL_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'APP_URL', 'RENDER', 'RENDER_SERVICE_ID',
];

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('default configuration is console transport and is reported as NOT delivering', async () => {
  await withEnv({}, () => {
    const s = emailStatus();
    assert.equal(s.transport, 'console');
    assert.equal(s.delivers, false);
    assert.ok(s.problems.some((p) => /no mail provider configured/i.test(p)));
  });
});

test('http transport with Resend-compatible settings is delivery-ready', async () => {
  await withEnv({
    EMAIL_TRANSPORT: 'http',
    EMAIL_HTTP_URL: 'https://api.resend.com/emails',
    EMAIL_HTTP_API_KEY: 're_test_key',
    EMAIL_FROM: 'Denti Clinics <no-reply@clinic.example>',
  }, () => {
    const s = emailStatus();
    assert.equal(s.transport, 'http');
    assert.equal(s.delivers, true);
    assert.deepEqual(s.problems, []);
  });
});

test('http transport without an API key is not delivery-ready (and names the missing variable)', async () => {
  await withEnv({
    EMAIL_TRANSPORT: 'http',
    EMAIL_HTTP_URL: 'https://api.resend.com/emails',
    EMAIL_FROM: 'Denti Clinics <no-reply@clinic.example>',
  }, () => {
    const s = emailStatus();
    assert.equal(s.delivers, false);
    assert.ok(s.problems.some((p) => p.includes('EMAIL_HTTP_API_KEY')));
  });
});

test('http transport without a real From address is not delivery-ready', async () => {
  await withEnv({
    EMAIL_TRANSPORT: 'http',
    EMAIL_HTTP_URL: 'https://api.resend.com/emails',
    EMAIL_HTTP_API_KEY: 're_test_key',
  }, () => {
    const s = emailStatus();
    assert.equal(s.delivers, false);
    assert.ok(s.problems.some((p) => p.includes('EMAIL_FROM')));
  });
});

test('SMTP on Render is flagged with the blocked-ports warning', async () => {
  await withEnv({
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'user@example.com',
    SMTP_PASS: 'secret',
    EMAIL_FROM: 'Denti Clinics <no-reply@example.com>',
    RENDER: 'true',
  }, () => {
    const s = emailStatus();
    assert.equal(s.delivers, true);
    assert.ok(s.warnings.some((w) => /SMTP ports 25, 465 and 587/.test(w)));
  });
});

test('demo / reserved recipient domains are detected before wasting a provider send', async () => {
  assert.match(undeliverableReason('owner@alamal.demo'), /demo\/reserved domain/);
  assert.match(undeliverableReason('someone@clinicportal.local'), /demo\/reserved domain/);
  assert.match(undeliverableReason('user@example.com'), /demo\/reserved domain/);
  assert.equal(undeliverableReason('owner@gmail.com'), null);

  await withEnv({
    EMAIL_TRANSPORT: 'http',
    EMAIL_HTTP_URL: 'https://api.resend.com/emails',
    EMAIL_HTTP_API_KEY: 're_test_key',
    EMAIL_FROM: 'Denti Clinics <no-reply@clinic.example>',
  }, async () => {
    // Returns false without any network call — a real provider would bounce.
    const sent = await sendMail({
      to: 'owner@alamal.demo', subject: 'x', text: 'x', html: '<p>x</p>',
    });
    assert.equal(sent, false);
  });
});

test('console transport keeps the message in the log (the documented fallback)', async () => {
  await withEnv({}, async () => {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const sent = await sendMail({
        to: 'staff@realclinic.com', subject: 'Your code', text: 'Your verification code: 123456', html: '<p>…</p>',
      });
      assert.equal(sent, true);
    } finally {
      console.log = original;
    }
    assert.ok(logs.some((line) => line.includes('[email:console]')));
    assert.ok(logs.some((line) => line.includes('123456')));
  });
});
