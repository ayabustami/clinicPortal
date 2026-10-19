/**
 * Login credential resolution (autofill-safe). Pure module — runs under plain
 * `node --test` with no DOM: npm test (client).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredentials } from '../src/loginCredentials.js';

/** Minimal stand-in for the browser FormData API used by the login form. */
const form = (values) => ({ get: (name) => (name in values ? values[name] : null) });

test('typed input: DOM and React state agree, values pass through', () => {
  const r = resolveCredentials({
    formData: form({ email: 'owner@alamal.demo', password: 'Demo1234!' }),
    email: 'owner@alamal.demo',
    password: 'Demo1234!',
  });
  assert.deepEqual(r, { email: 'owner@alamal.demo', password: 'Demo1234!', missing: [] });
});

test('autofill without input events: DOM has values, React state is empty -> DOM wins', () => {
  // This is the exact case that produced `email is required` from the API.
  const r = resolveCredentials({
    formData: form({ email: 'owner@alamal.demo', password: 'Demo1234!' }),
    email: '',
    password: '',
  });
  assert.equal(r.email, 'owner@alamal.demo');
  assert.equal(r.password, 'Demo1234!');
  assert.deepEqual(r.missing, []);
});

test('React state used only when the DOM value is absent', () => {
  const r = resolveCredentials({ formData: form({ email: '', password: '' }), email: ' a@b.co ', password: 'pw' });
  assert.equal(r.email, 'a@b.co'); // trimmed
  assert.equal(r.password, 'pw');
  assert.deepEqual(r.missing, []);
});

test('genuinely empty fields are reported as missing, never sent as empty strings', () => {
  const r = resolveCredentials({ formData: form({ email: '', password: '' }), email: '', password: '' });
  assert.deepEqual(r.missing, ['email', 'password']);
});

test('whitespace-only email and password count as missing (server trims them too)', () => {
  const r = resolveCredentials({ formData: form({ email: '   ', password: '   ' }) });
  assert.deepEqual(r.missing, ['email', 'password']);
});

test('no FormData available (e.g. older browser): falls back to React state', () => {
  const r = resolveCredentials({ formData: null, email: 'x@y.co', password: 'secret' });
  assert.deepEqual(r, { email: 'x@y.co', password: 'secret', missing: [] });
  assert.deepEqual(resolveCredentials().missing, ['email', 'password']);
});

test('non-string FormData entries (e.g. File) are ignored', () => {
  const r = resolveCredentials({ formData: form({ email: { name: 'f' }, password: 'pw' }), email: 'a@b.co' });
  assert.equal(r.email, 'a@b.co');
  assert.deepEqual(r.missing, []);
});
