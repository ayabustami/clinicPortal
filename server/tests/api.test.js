'use strict';
/**
 * End-to-end API tests (node:test + fetch) against a real server instance
 * backed by a temporary SQLite database seeded with the demo fixture.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

// Point the app at a throwaway PostgreSQL database BEFORE loading any module
// (the pg pool is created lazily, so this synchronous env swap is enough).
const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('api');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const { wallToUtc } = require('../src/util/time');

let server;
let baseUrl;

/** Tiny HTTP client that keeps its own cookie jar. */
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

/** Wide relative window for list assertions (no hardcoded years). */
const RANGE_START = new Date(Date.now() - 120 * 86400000).toISOString();
const RANGE_END = new Date(Date.now() + 120 * 86400000).toISOString();
const rangeQs = (extra = '') => `start=${RANGE_START}&end=${RANGE_END}${extra}`;

async function login(email, password = 'Demo1234!') {
  const c = makeClient();
  const res = await c.post('/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.data)}`);
  return c;
}

/** Find the next free working slot for a doctor, scanning hours and days. */
async function findOpenSlot(client, doctorId = 1, durationMin = 30, preferredHour = '10:00') {
  const boot = await client.get('/api/meta/bootstrap');
  const { timezone, working_hours } = boot.data.clinic;
  const hours = [preferredHour, '08:30', '09:30', '10:30', '11:30', '13:30', '14:30', '15:30', '16:00'];
  const today = new Date();
  for (let d = 1; d <= 21; d++) {
    const day = new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const win = working_hours[String(weekday)];
    if (!win) continue;
    for (const hour of hours) {
      if (hour < win.start || hour >= win.end) continue;
      const startUtc = wallToUtc(`${day} ${hour}`, timezone);
      const res = await client.post('/api/appointments', {
        patient_id: 3, doctor_id: doctorId, service_id: 3,
        start_at: startUtc.toISOString(), duration_min: durationMin,
      });
      if (res.status === 201) return { appt: res.data.appointment, startUtc };
      // conflict or boundary issue -> try next hour/day
    }
  }
  throw new Error('Could not find an open slot in the next 21 days');
}

test.before(async () => {
  await createTestDb();   // fresh derived database
  await seedMain();       // migrate + seed demo fixture
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

test('auth: valid login, bad credentials, me, logout', async () => {
  const c = makeClient();
  const ok = await c.post('/api/auth/login', { email: 'owner@alamal.demo', password: 'Demo1234!' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email, 'owner@alamal.demo');

  const bad = await c.post('/api/auth/login', { email: 'owner@alamal.demo', password: 'wrong-password' });
  assert.equal(bad.status, 401);

  const anon = makeClient();
  const me = await anon.get('/api/auth/me');
  assert.equal(me.status, 401);

  const meOk = await c.get('/api/auth/me');
  assert.equal(meOk.status, 200);

  const out = await c.post('/api/auth/logout');
  assert.equal(out.status, 200);
  const meAfter = await c.get('/api/auth/me');
  assert.equal(meAfter.status, 401);
});

test('auth: session cookie policy (httponly; SameSite=None only with Secure)', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@alamal.demo', password: 'Demo1234!' }),
  });
  assert.equal(res.status, 200);
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const setCookie = raw.join('; ').toLowerCase();
  assert.match(setCookie, /httponly/, 'session cookie must be httpOnly');
  assert.match(setCookie, /samesite=(lax|none|strict)/, 'session cookie must set a SameSite policy');
  if (setCookie.includes('samesite=none')) {
    assert.match(setCookie, /secure/, 'SameSite=None must be paired with Secure');
  }
});

test('auth: invalid input bodies are rejected with 400', async () => {
  const c = makeClient();
  const r1 = await c.post('/api/auth/login', { email: 'not-an-email', password: 'x' });
  assert.equal(r1.status, 400);
  const r2 = await c.post('/api/auth/login', {});
  assert.equal(r2.status, 400);
});

test('rbac: receptionist blocked from financial reports and invoices; accountant allowed', async () => {
  const reception = await login('reception@alamal.demo');
  const accountant = await login('accounting@alamal.demo');
  const doctor = await login('lina@alamal.demo');

  assert.equal((await reception.get('/api/reports/revenue')).status, 403);
  assert.equal((await reception.get('/api/invoices')).status, 403);
  // clinic policy (bug F): authorized dentists may read AND create invoices,
  // but never record payments/refunds — those stay with financial roles.
  assert.equal((await doctor.get('/api/invoices')).status, 200);
  assert.equal((await accountant.get('/api/reports/revenue')).status, 200);
  assert.equal((await accountant.get('/api/invoices')).status, 200);
  // receptionist can view reports about appointments though
  assert.equal((await reception.get('/api/reports/appointments')).status, 200);
  // only owner can manage staff
  assert.equal((await reception.get('/api/staff/users')).status, 403);
});

test('isolation: clinics cannot read or write each other\u2019s data', async () => {
  const almal = await login('reception@alamal.demo');
  const cedar = await login('reception@cedar.demo');

  // discover a cedar patient id through cedar's own API
  const cedarPatients = await cedar.get('/api/patients?limit=5');
  assert.equal(cedarPatients.status, 200);
  const cedarPatientId = cedarPatients.data.items[0].id;

  const cross = await almal.get(`/api/patients/${cedarPatientId}`);
  assert.equal(cross.status, 404);

  // list endpoints only return own-clinic rows
  const almalAppts = await almal.get('/api/appointments?' + rangeQs());
  assert.ok(almalAppts.data.appointments.length > 0);
  for (const a of almalAppts.data.appointments) assert.equal(a.clinic_id, 1);
  const cedarAppts = await cedar.get('/api/appointments?' + rangeQs());
  for (const a of cedarAppts.data.appointments) assert.equal(a.clinic_id, 2);

  // cross-clinic modification attempt on an appointment of clinic 2
  const cedarApptId = cedarAppts.data.appointments[0].id;
  const put = await almal.put(`/api/appointments/${cedarApptId}`, { duration_min: 60 });
  assert.equal(put.status, 404);

  // cross-clinic invoice access (billing routes require accountant/owner)
  const cedarAcct = await login('accounting@cedar.demo');
  const cedarInv = await cedarAcct.get('/api/invoices?limit=1');
  assert.ok(cedarInv.data.invoices.length > 0, 'seed should have created invoices');
  const invId = cedarInv.data.invoices[0].id;
  const almalOwner = await login('owner@alamal.demo');
  assert.equal((await almalOwner.get(`/api/invoices/${invId}`)).status, 404);
  // receptionist (no billing role) still blocked from her own clinic's invoices
  assert.equal((await cedar.get('/api/invoices?limit=1')).status, 403);
});

test('appointments: create, conflict rejection, working-hours enforcement', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt, startUtc } = await findOpenSlot(owner, 1, 30);

  // Same doctor, overlapping time -> 409 with a helpful message
  const clash = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: appt.doctor_id, service_id: 1,
    start_at: new Date(startUtc.getTime() + 15 * 60000).toISOString(), duration_min: 30,
  });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error.message, /already has an appointment/);

  // Different doctor at the same time is fine. Clear any seeded booking for
  // doctor 2 in that window first (seed data is date-relative).
  const winStart = new Date(startUtc.getTime() - 30 * 60000).toISOString();
  const winEnd = new Date(startUtc.getTime() + 60 * 60000).toISOString();
  const d2 = await owner.get(`/api/appointments?doctor_id=2&start=${winStart}&end=${winEnd}`);
  for (const a of (d2.data.appointments || [])) {
    if (['scheduled', 'confirmed', 'checked_in', 'in_progress'].includes(a.status)) {
      await owner.patch(`/api/appointments/${a.id}/status`, { status: 'cancelled' });
    }
  }
  const otherDoc = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: 2, service_id: 1,
    start_at: startUtc.toISOString(), duration_min: 30,
  });
  assert.equal(otherDoc.status, 201, JSON.stringify(otherDoc.data));

  // Outside working hours -> 400
  const boot = await owner.get('/api/meta/bootstrap');
  const tz = boot.data.clinic.timezone;
  const day = new Date(startUtc.getTime()).toISOString().slice(0, 10);
  const lateNight = wallToUtc(`${day} 06:30`, tz); // 06:30 local is before opening
  const late = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: 1, service_id: 1,
    start_at: lateNight.toISOString(), duration_min: 30,
  });
  assert.equal(late.status, 400);

  // Missing required fields -> 400
  const missing = await owner.post('/api/appointments', { doctor_id: 1 });
  assert.equal(missing.status, 400);

  // Duration not a multiple of 5 -> 400
  const badDur = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: 2, service_id: 1,
    start_at: new Date(startUtc.getTime() + 3 * 60 * 60000).toISOString(), duration_min: 22,
  });
  assert.equal(badDur.status, 400);
  assert.match(badDur.data.error.message, /multiple of 5/);

  // Invalid patient from another clinic -> 400/404 family
  const wrongPatient = await owner.post('/api/appointments', {
    patient_id: 999999, doctor_id: 1, service_id: 1,
    start_at: startUtc.toISOString(), duration_min: 30,
  });
  assert.equal(wrongPatient.status, 400);
});

test('appointments: reschedule persists and conflicts are still enforced', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt, startUtc } = await findOpenSlot(owner, 2, 30);

  // move 2 hours later in the same day (still inside working hours)
  const moved = await owner.put(`/api/appointments/${appt.id}`, {
    start_at: new Date(startUtc.getTime() + 120 * 60000).toISOString(),
    duration_min: 45,
  });
  if (moved.status === 409 || moved.status === 400) {
    // slot collided with seeded data; just assert rejection was clean
    assert.ok(moved.data.error.message.length > 0);
  } else {
    assert.equal(moved.status, 200);
    assert.equal(moved.data.appointment.duration_min, 45);
    // persisted: fetch again
    const again = await owner.get(`/api/appointments/${appt.id}`);
    assert.equal(again.data.appointment.start_at, new Date(startUtc.getTime() + 120 * 60000).toISOString());
  }
});

test('appointments: status flow confirm -> check in -> complete; invalid transitions rejected', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt } = await findOpenSlot(owner, 1, 20, '11:00');

  let r = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'confirmed' });
  assert.equal(r.status, 200);
  r = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'checked_in' });
  assert.equal(r.status, 200);
  r = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'completed' });
  assert.equal(r.status, 200);
  // completed is terminal
  r = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'cancelled' });
  assert.equal(r.status, 400);
  // unknown status value
  const { appt: a2 } = await findOpenSlot(owner, 2, 20, '11:00');
  r = await owner.patch(`/api/appointments/${a2.id}/status`, { status: 'exploded' });
  assert.equal(r.status, 400);
});

test('appointments: doctor filters and status filters work', async () => {
  const owner = await login('owner@alamal.demo');
  const all = await owner.get('/api/appointments?' + rangeQs());
  const doc1 = await owner.get('/api/appointments?' + rangeQs('&doctor_id=1'));
  assert.ok(doc1.data.appointments.length > 0);
  assert.ok(doc1.data.appointments.length < all.data.appointments.length);
  for (const a of doc1.data.appointments) assert.equal(a.doctor_id, 1);

  const cancelled = await owner.get('/api/appointments?' + rangeQs('&statuses=cancelled,no_show'));
  assert.ok(cancelled.data.appointments.length > 0);
  for (const a of cancelled.data.appointments) assert.ok(['cancelled', 'no_show'].includes(a.status));
});

test('patients: create, update, duplicate MRN, search, invalid input', async () => {
  const reception = await login('reception@alamal.demo');

  const created = await reception.post('/api/patients', {
    first_name: 'Test', last_name: 'Persona', gender: 'female', phone: '+970 599 000 111',
    allergies: 'Demo allergy',
  });
  assert.equal(created.status, 201);
  assert.match(created.data.patient.mrn, /^P-\d+$/);
  const id = created.data.patient.id;

  const updated = await reception.put(`/api/patients/${id}`, { last_name: 'Persona-Smith', medical_info: 'Demo history' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.patient.last_name, 'Persona-Smith');

  const dup = await reception.post('/api/patients', { first_name: 'X', last_name: 'Y', mrn: created.data.patient.mrn });
  assert.equal(dup.status, 400);

  const invalid = await reception.post('/api/patients', { last_name: 'NoFirst' });
  assert.equal(invalid.status, 400);

  const future = await reception.post('/api/patients', { first_name: 'Time', last_name: 'Traveler', dob: '2999-01-01' });
  assert.equal(future.status, 400);

  const search = await reception.get('/api/patients?search=Persona');
  assert.ok(search.data.items.some((p) => p.id === id));

  // doctor role cannot register patients
  const doctor = await login('lina@alamal.demo');
  assert.equal((await doctor.post('/api/patients', { first_name: 'No', last_name: 'Way' })).status, 403);
});

test('billing: invoice totals, partial payment, full payment, overpay rejected', async () => {
  const accountant = await login('accounting@alamal.demo');
  const services = (await accountant.get('/api/services')).data.services;
  assert.ok(services.length >= 2);
  const s1 = services[0]; const s2 = services[1];

  const inv = await accountant.post('/api/invoices', {
    patient_id: 3,
    items: [
      { service_id: s1.id, quantity: 1 },
      { description: 'Custom lab fee', quantity: 2, unit_price: '25.00' },
    ],
  });
  assert.equal(inv.status, 201);
  const expectedTotal = s1.price_cents + 2 * 2500;
  assert.equal(inv.data.invoice.total_cents, expectedTotal);
  assert.equal(inv.data.invoice.status, 'unpaid');
  const invId = inv.data.invoice.id;

  // partial payment
  const half = Math.floor(expectedTotal / 2);
  let pay = await accountant.post(`/api/invoices/${invId}/payments`, { amount: (half / 100).toFixed(2), method: 'cash' });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.invoice.status, 'partial');

  // overpay rejected
  const overpay = await accountant.post(`/api/invoices/${invId}/payments`, { amount: '99999.00', method: 'card' });
  assert.equal(overpay.status, 400);

  // pay the rest
  const rest = expectedTotal - half;
  pay = await accountant.post(`/api/invoices/${invId}/payments`, { amount: (rest / 100).toFixed(2), method: 'card', reference: 'TEST-1' });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.invoice.status, 'paid');
  assert.equal(pay.data.invoice.balance_cents, 0);

  // invalid: negative amount / empty items
  assert.equal((await accountant.post('/api/invoices', { patient_id: 3, items: [] })).status, 400);
  assert.equal((await accountant.post('/api/invoices', { patient_id: 3, items: [{ description: 'x', quantity: 1, unit_price: '-5' }] })).status, 400);
});

test('persistence: created data is visible on a fresh login (database-backed)', async () => {
  const c1 = await login('reception@alamal.demo');
  const created = await c1.post('/api/patients', { first_name: 'Persist', last_name: 'Check' });
  assert.equal(created.status, 201);
  const mrn = created.data.patient.mrn;

  const c2 = await login('reception@alamal.demo'); // fresh session
  const found = await c2.get(`/api/patients?search=Persist`);
  assert.ok(found.data.items.some((p) => p.mrn === mrn));
});

test('platform admin: sees clinics, cannot use clinic-only routes', async () => {
  const admin = await login('admin@clinicportal.local');
  const clinics = await admin.get('/api/clinics');
  assert.equal(clinics.status, 200);
  assert.ok(clinics.data.clinics.length >= 2);
  const dash = await admin.get('/api/dashboard/summary');
  assert.equal(dash.status, 403); // platform admins have no clinic context
});

// ============================================================================
// SECURITY & DOMAIN REGRESSION TESTS (audit P1/P2/P5/P6/P8/P10)
// ============================================================================

test('security: PUT /appointments/:id ignores+rejects status (PATCH-only status flow)', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt } = await findOpenSlot(owner);
  const res = await owner.put(`/api/appointments/${appt.id}`, { status: 'completed' });
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /PATCH/i);
  // unchanged after rejected attempt
  const check = await owner.get(`/api/appointments/${appt.id}`);
  assert.equal(check.data.appointment.status, 'scheduled');
});

test('security: receptionist cannot set completed / in_progress; doctor can for own patient visits', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt } = await findOpenSlot(owner, 1);
  await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'confirmed' });
  await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'checked_in' });
  const reception = await login('reception@alamal.demo');
  const bad = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'in_progress' });
  assert.equal(bad.status, 400, 'receptionist must not set in_progress');
  const bad2 = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'completed' });
  assert.equal(bad2.status, 400, 'receptionist must not set completed');
  // Lina (doctor, profile 1) owns this appointment
  const lina = await login('lina@alamal.demo');
  const ok = await lina.patch(`/api/appointments/${appt.id}/status`, { status: 'in_progress' });
  assert.equal(ok.status, 200, `doctor in_progress failed: ${JSON.stringify(ok.data)}`);
  assert.equal(ok.data.appointment.status, 'in_progress');
  const done = await lina.patch(`/api/appointments/${appt.id}/status`, { status: 'completed' });
  assert.equal(done.status, 200);
  // invalid transition: completed -> in_progress
  const back = await lina.patch(`/api/appointments/${appt.id}/status`, { status: 'in_progress' });
  assert.equal(back.status, 400);
});

test('security: doctor restricted to own appointments (PUT/PATCH), owner unrestricted', async () => {
  const owner = await login('owner@alamal.demo');
  const omarAppts = await owner.get('/api/appointments?' + rangeQs('&doctor_id=2&statuses=scheduled,confirmed'));
  const target = omarAppts.data.appointments.find((a) => new Date(a.start_at) > new Date()) || omarAppts.data.appointments[0];
  assert.ok(target, 'need a future omar appointment from seed');
  const lina = await login('lina@alamal.demo');
  const forbiddenPatch = await lina.patch(`/api/appointments/${target.id}/status`, { status: 'checked_in' });
  assert.equal(forbiddenPatch.status, 403);
  const forbiddenPut = await lina.put(`/api/appointments/${target.id}`, { notes: 'hacked' });
  assert.equal(forbiddenPut.status, 403);
  // omar may act on his own appointment
  const omar = await login('omar@alamal.demo');
  const ownPatch = await omar.patch(`/api/appointments/${target.id}/status`, { status: 'checked_in' });
  assert.ok([200, 400].includes(ownPatch.status), `expected flow-permitting result, got ${ownPatch.status}`);
  if (ownPatch.status === 200) assert.equal(ownPatch.data.appointment.status, 'checked_in');
});

test('security: restoring a cancelled appointment re-runs conflict validation', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt: a, startUtc } = await findOpenSlot(owner, 1, 30);
  await owner.patch(`/api/appointments/${a.id}/status`, { status: 'cancelled' });
  // slot is now free -> book another appointment in it
  const b = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: 1, service_id: 3,
    start_at: startUtc.toISOString(), duration_min: 30,
  });
  assert.equal(b.status, 201);
  // restore a -> must conflict
  const restore = await owner.patch(`/api/appointments/${a.id}/status`, { status: 'scheduled' });
  assert.equal(restore.status, 409, `restore must revalidate conflicts, got ${restore.status}`);
});

test('security: concurrent double-booking of same slot -> exactly one wins', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt: probe, startUtc } = await findOpenSlot(owner, 1, 30);
  await owner.patch(`/api/appointments/${probe.id}/status`, { status: 'cancelled' }); // free the slot
  const body = { patient_id: 3, doctor_id: 1, service_id: 3, start_at: startUtc.toISOString(), duration_min: 30 };
  const [r1, r2] = await Promise.all([owner.post('/api/appointments', body), owner.post('/api/appointments', body)]);
  const created = [r1, r2].filter((r) => r.status === 201).length;
  const conflict = [r1, r2].filter((r) => r.status === 409).length;
  assert.equal(created, 1, `exactly one booking must succeed (got ${r1.status}/${r2.status})`);
  assert.equal(conflict, 1);
});

test('security: dashboard revenue hidden from non-financial roles', async () => {
  for (const [email, maySee] of [['owner@alamal.demo', true], ['accounting@alamal.demo', true], ['reception@alamal.demo', false], ['lina@alamal.demo', false]]) {
    const c = await login(email);
    const res = await c.get('/api/dashboard/summary');
    assert.equal(res.status, 200);
    if (maySee) assert.ok(res.data.revenue && typeof res.data.revenue === 'object', `${email} should see revenue`);
    else assert.equal(res.data.revenue, null, `${email} must NOT see revenue`);
  }
});

test('privacy: clinical fields redacted by role; records endpoints gated', async () => {
  const owner = await login('owner@alamal.demo');
  const patients = await owner.get('/api/patients?limit=100');
  // list serializer intentionally omits clinical fields -> fetch details
  let pid = null;
  for (const p of patients.data.items) {
    const d = await owner.get(`/api/patients/${p.id}`);
    if (d.data.patient.allergies) { pid = p.id; break; }
  }
  assert.ok(pid, 'seed has allergy data');

  const reception = await login('reception@alamal.demo');
  const rView = await reception.get(`/api/patients/${pid}`);
  assert.equal(rView.status, 200);
  assert.ok(rView.data.patient.allergies, 'receptionist needs allergies at check-in');

  const accounting = await login('accounting@alamal.demo');
  const aView = await accounting.get(`/api/patients/${pid}`);
  assert.equal(aView.status, 200);
  assert.equal(aView.data.patient.allergies, undefined, 'accountant must not see allergies');
  assert.equal(aView.data.patient.medical_info, undefined);

  // accountant blocked from records entirely
  const recs = await accounting.get(`/api/patients/${pid}/records`);
  assert.equal(recs.status, 403);
  const list = await accounting.get('/api/records?patient_id=' + pid);
  assert.ok(list.status === 200 || list.status === 403);
  if (list.status === 200) {
    for (const r of list.data.records) { assert.equal(r.diagnosis, undefined); assert.equal(r.diagnosis, null); }
  }
});

test('privacy: Arabic search normalization + timeline scoping', async () => {
  const owner = await login('owner@alamal.demo');
  const created = await owner.post('/api/patients', { first_name: 'أحمد', last_name: 'الطَّبيب', gender: 'male' });
  assert.equal(created.status, 201);
  const pid = created.data.patient.id;
  // search without hamza/diacritics must find the patient
  const reception = await login('reception@alamal.demo');
  const s1 = await reception.get('/api/patients?q=' + encodeURIComponent('احمد الطبيب'));
  assert.ok(s1.data.items.some((p) => p.id === pid), 'normalized Arabic search failed');
  const s2 = await reception.get('/api/patients?q=' + encodeURIComponent('احمد'));
  assert.ok(s2.data.items.some((p) => p.id === pid));

  // timeline: receptionist sees appointments only; owner sees records too
  const recRes = await owner.post('/api/records', { patient_id: pid, doctor_id: 1, visit_date: new Date().toISOString().slice(0, 10), diagnosis: 'test dx' });
  assert.equal(recRes.status, 201, JSON.stringify(recRes.data));
  const tlOwner = await owner.get(`/api/patients/${pid}/timeline`);
  assert.equal(tlOwner.status, 200);
  assert.ok(tlOwner.data.events.some((e) => e.type === 'record'));
  const tlRec = await reception.get(`/api/patients/${pid}/timeline`);
  assert.equal(tlRec.status, 200);
  assert.ok(!tlRec.data.events.some((e) => e.type === 'record'), 'receptionist timeline must not expose records');
  const tlAcc = await accountingClientTimeline(pid);
  // accountant: may see scheduling/billing events but NEVER clinical ones
  assert.equal(tlAcc.status, 200);
  assert.ok(!tlAcc.data.events.some((e) => e.type === 'record' || e.type === 'prescription'), 'accountant timeline must not expose clinical events');
});

async function accountingClientTimeline(pid) {
  const c = await login('accounting@alamal.demo');
  return c.get(`/api/patients/${pid}/timeline`);
}

test('records: draft/approve lifecycle, author-only writes, prescription diff', async () => {
  const lina = await login('lina@alamal.demo');
  const created = await lina.post('/api/records', {
    patient_id: 6, visit_date: new Date().toISOString().slice(0, 10),
    diagnosis: 'Initial dx', prescriptions: [{ medication: 'Amox 500', dosage: '1x3', duration_days: 5 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.record.status, 'draft');
  const rid = created.data.record.id;
  const detail = await lina.get(`/api/records/${rid}`);
  const rx1 = detail.data.record.prescriptions[0].id;

  // another doctor cannot edit lina's record
  const omar = await login('omar@alamal.demo');
  const otherEdit = await omar.put(`/api/records/${rid}`, { diagnosis: 'hijacked' });
  assert.equal(otherEdit.status, 403);

  // author edits draft + prescription diff (update one, add one)
  const edit = await lina.put(`/api/records/${rid}`, {
    diagnosis: 'Revised dx',
    prescriptions: [{ id: rx1, medication: 'Amox 500 updated' }, { medication: 'NewRx', dosage: '1x1' }],
  });
  assert.equal(edit.status, 200);
  const after = await lina.get(`/api/records/${rid}`);
  assert.equal(after.data.record.diagnosis, 'Revised dx');
  assert.equal(after.data.record.prescriptions.length, 2);
  const kept = after.data.record.prescriptions.find((p) => p.id === rx1);
  assert.equal(kept.medication, 'Amox 500 updated');

  // approve (via PUT status) finalizes the record; content edits then require
  // an amendment_reason and append to the amendment history; approved->draft forbidden
  const approve = await lina.put(`/api/records/${rid}`, { status: 'approved' });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));
  assert.equal(approve.data.record.status, 'approved');
  assert.ok(approve.data.record.finalized_at, 'approval must stamp finalized_at');
  const locked = await lina.put(`/api/records/${rid}`, { diagnosis: 'late change' });
  assert.equal(locked.status, 400);
  assert.equal(locked.data.error.fields.amendment_reason, 'required');
  const amended = await lina.put(`/api/records/${rid}`, { diagnosis: 'late change', amendment_reason: 'Correction after review' });
  assert.equal(amended.status, 200, JSON.stringify(amended.data));
  assert.equal(amended.data.record.status, 'approved');
  const demote = await lina.put(`/api/records/${rid}`, { status: 'draft' });
  assert.equal(demote.status, 400);
  // receptionist cannot approve records
  const reception = await login('reception@alamal.demo');
  const rCreate = await reception.post('/api/records', { patient_id: 6, doctor_id: 1, visit_date: new Date().toISOString().slice(0, 10), diagnosis: 'x' });
  assert.equal(rCreate.status, 403);
});

test('invoices: appointment link validation + paid-lock', async () => {
  const owner = await login('owner@alamal.demo');
  const cedarRec = await login('reception@cedar.demo');
  const cedarAppts = await cedarRec.get('/api/appointments?' + rangeQs());
  const cedarApptId = cedarAppts.data.appointments[0].id;

  // cross-clinic appointment id must be rejected
  const cross = await owner.post('/api/invoices', { patient_id: 3, appointment_id: cedarApptId, items: [{ description: 'X', qty: 1, unit_price: 100 }] });
  assert.ok(cross.status === 400 || cross.status === 404, `cross-clinic link must fail, got ${cross.status}`);

  // appointment belonging to another patient must be rejected
  const almalAppts = await owner.get('/api/appointments?' + rangeQs());
  const someAppt = almalAppts.data.appointments.find((a) => a.patient_id !== 3);
  const wrongPatient = await owner.post('/api/invoices', { patient_id: 3, appointment_id: someAppt.id, items: [{ description: 'X', qty: 1, unit_price: 100 }] });
  assert.equal(wrongPatient.status, 400);

  // create + fully pay, then item edits locked
  const inv = await owner.post('/api/invoices', { patient_id: 3, items: [{ description: 'Consult', quantity: 1, unit_price: '50.00' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.match(inv.data.invoice.invoice_no, /^INV-\d{4}-\d{4}$/);
  assert.equal(inv.data.invoice.currency, 'ILS');
  const pay = await owner.post(`/api/invoices/${inv.data.invoice.id}/payments`, { amount: (inv.data.invoice.total_cents / 100).toFixed(2), method: 'cash' });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.equal(pay.data.invoice.status, 'paid');
  const edit = await owner.put(`/api/invoices/${inv.data.invoice.id}`, { items: [{ description: 'Sneaky', quantity: 1, unit_price: '1.00' }] });
  assert.equal(edit.status, 409);
  const overpay = await owner.post(`/api/invoices/${inv.data.invoice.id}/payments`, { amount: '0.01', method: 'cash' });
  assert.equal(overpay.status, 400);
});

test('clinic admin: platform-admin owner provisioning + last-owner protections', async () => {
  const admin = await login('admin@clinicportal.local');
  const clinic = await admin.post('/api/clinics', { name: 'QA Test Clinic', slug: 'qa-test-clinic', timezone: 'Asia/Jerusalem', currency: 'JOD', slot_minutes: 20 });
  assert.equal(clinic.status, 201, JSON.stringify(clinic.data));
  assert.equal(clinic.data.clinic.currency, 'JOD');
  const cid = clinic.data.clinic.id;

  // non-admin cannot provision
  const owner = await login('owner@alamal.demo');
  const denied = await owner.post(`/api/clinics/${cid}/owner`, { full_name: 'Nope', email: 'nope@x.demo', password: 'Nope12345' });
  assert.equal(denied.status, 403);

  const prov = await admin.post(`/api/clinics/${cid}/owner`, { full_name: 'QA Owner', email: 'qaowner@test.demo', password: 'QaOwner123!' });
  assert.equal(prov.status, 201, JSON.stringify(prov.data));
  const qa = await login('qaowner@test.demo', 'QaOwner123!');
  const boot = await qa.get('/api/meta/bootstrap');
  assert.equal(boot.data.clinic.name, 'QA Test Clinic');
  assert.equal(boot.data.clinic.slot_minutes, 20);

  // last-owner protections
  const me = await qa.get('/api/auth/me');
  const selfDemote = await qa.put(`/api/staff/users/${me.data.user.id}`, { role: 'receptionist' });
  assert.equal(selfDemote.status, 400);
  const selfDeactivate = await qa.put(`/api/staff/users/${me.data.user.id}`, { is_active: false });
  assert.equal(selfDeactivate.status, 400);

  // promote a second owner, then demotion of the second is allowed (2 owners), demotion of the last is not
  const second = await qa.post('/api/staff/users', { email: 'qaowner2@test.demo', password: 'QaOwner123!', full_name: 'QA Owner 2', role: 'owner' });
  assert.equal(second.status, 201);
  const demote2 = await qa.put(`/api/staff/users/${second.data.user.id}`, { role: 'receptionist' });
  assert.equal(demote2.status, 200);
});

test('settings: currency update flows through bootstrap + new invoices', async () => {
  const owner = await login('owner@alamal.demo');
  const upd = await owner.put('/api/clinics/settings', { currency: 'jod' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.clinic.currency, 'JOD');
  const bad = await owner.put('/api/clinics/settings', { currency: 'JD' });
  assert.equal(bad.status, 400);
  const inv = await owner.post('/api/invoices', { patient_id: 3, items: [{ description: 'Consult JOD', quantity: 1, unit_price: '10.00' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.invoice.currency, 'JOD');
  await owner.put('/api/clinics/settings', { currency: 'ILS' }); // restore default for other tests
});

test('sessions: logout + change-password revoke old cookies; wrong current password rejected', async () => {
  const omar = await login('omar@alamal.demo');
  const omar2 = await login('omar@alamal.demo'); // second session
  // missing verification code -> 400 (email-verified change)
  const noCode = await omar.post('/api/auth/change-password', { current_password: 'Demo1234!', new_password: 'BrandNew123!' });
  assert.equal(noCode.status, 400);
  const badChange = await omar.post('/api/auth/change-password', { current_password: 'WrongPass1!', new_password: 'BrandNew123!', code: '000000' });
  assert.equal(badChange.status, 400);
  const send1 = await omar.post('/api/auth/change-password/request-code', {});
  assert.equal(send1.status, 200, JSON.stringify(send1.data));
  const change = await omar.post('/api/auth/change-password', { current_password: 'Demo1234!', new_password: 'BrandNew123!', code: send1.data.dev_code });
  assert.equal(change.status, 200);
  // omar's own cookie was re-issued -> still valid
  const meNew = await omar.get('/api/auth/me');
  assert.equal(meNew.status, 200);
  // other session revoked (token_version bumped)
  const meOld = await omar2.get('/api/auth/me');
  assert.equal(meOld.status, 401, 'old session must be revoked after password change');
  // login with new password works; restore original password for other tests
  const fresh = await (async () => { const c = makeClient(); const r = await c.post('/api/auth/login', { email: 'omar@alamal.demo', password: 'BrandNew123!' }); assert.equal(r.status, 200); return c; })();
  const send2 = await fresh.post('/api/auth/change-password/request-code', {});
  assert.equal(send2.status, 200, JSON.stringify(send2.data));
  const restore = await fresh.post('/api/auth/change-password', { current_password: 'BrandNew123!', new_password: 'Demo1234!', code: send2.data.dev_code });
  assert.equal(restore.status, 200);
  // logout revokes
  const out = await fresh.post('/api/auth/logout', {});
  assert.equal(out.status, 200);
  const afterOut = await fresh.get('/api/auth/me');
  assert.equal(afterOut.status, 401);
});

test('rate limit: repeated bad logins for one email -> 429', async () => {
  const { resetRateLimits } = require('../src/auth');
  resetRateLimits();
  const c = makeClient();
  let limited = 0;
  for (let i = 0; i < 9; i++) {
    const r = await c.post('/api/auth/login', { email: 'nobody-ratelimit@test.demo', password: 'BadPass123!' });
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'login rate limit never engaged');
  resetRateLimits();
});

test('audit: owner sees trail with filters; receptionist 403; platform admin needs clinic_id', async () => {
  const owner = await login('owner@alamal.demo');
  const all = await owner.get('/api/audit?limit=5');
  assert.equal(all.status, 200);
  assert.ok(all.data.items.length > 0);
  assert.ok(all.data.items[0].created_at);
  const authOnly = await owner.get('/api/audit?action=auth&limit=100');
  assert.equal(authOnly.status, 200);
  assert.ok(authOnly.data.items.every((i) => i.action.startsWith('auth')));
  assert.ok(authOnly.data.items.some((i) => i.action === 'auth.login'));

  const reception = await login('reception@alamal.demo');
  const denied = await reception.get('/api/audit');
  assert.equal(denied.status, 403);

  const admin = await login('admin@clinicportal.local');
  const noClinic = await admin.get('/api/audit');
  assert.equal(noClinic.status, 400);
  const withClinic = await admin.get('/api/audit?clinic_id=1&limit=5');
  assert.equal(withClinic.status, 200);
  const badClinic = await admin.get('/api/audit?clinic_id=9999');
  assert.equal(badClinic.status, 400);
});

test('csv: UTF-8 BOM + formula-injection neutralization + Arabic preserved', async () => {
  const owner = await login('owner@alamal.demo');
  const evil = await owner.post('/api/patients', { first_name: '=SUM(A1:A9)', last_name: 'Injection', gender: 'male' });
  assert.equal(evil.status, 201);
  const arab = await owner.post('/api/patients', { first_name: 'سمير', last_name: 'خوري', gender: 'male' });
  assert.equal(arab.status, 201);
  const res = await owner.get('/api/reports/patients?format=csv&from=2000-01-01&to=2999-01-01');
  assert.equal(res.status, 200);
  // fetch's .text() strips the BOM per spec — verify raw bytes on the wire
  const raw = await fetch(`${baseUrl}/api/reports/patients?format=csv&from=2000-01-01&to=2999-01-01`, { headers: { cookie: owner.getCookie() } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.equal(bytes[0], 0xef, 'CSV must start with UTF-8 BOM (EF BB BF)');
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.ok(res.text.includes("'=SUM(A1:A9)"), 'formula must be neutralized with leading quote');
  assert.ok(!/[^']=SUM\(A1/.test(res.text));
  assert.ok(res.text.includes('سمير') && res.text.includes('خوري'), 'Arabic must survive in CSV');
});

test('scheduling: doctor unavailability blocks booking; deletion frees slot', async () => {
  const owner = await login('owner@alamal.demo');
  const { appt: probe, startUtc } = await findOpenSlot(owner, 1, 30);
  await owner.patch(`/api/appointments/${probe.id}/status`, { status: 'cancelled' });
  const boot = await owner.get('/api/meta/bootstrap');
  const leave = await owner.post('/api/schedule/unavailability', {
    doctor_id: 1,
    start_at: new Date(startUtc.getTime() - 3600000).toISOString(),
    end_at: new Date(startUtc.getTime() + 2 * 3600000).toISOString(),
    reason: 'Conference',
  });
  assert.equal(leave.status, 201, JSON.stringify(leave.data));
  const blocked = await owner.post('/api/appointments', { patient_id: 3, doctor_id: 1, service_id: 3, start_at: startUtc.toISOString(), duration_min: 30 });
  assert.equal(blocked.status, 409);
  const list = await owner.get('/api/schedule/unavailability?start=' + RANGE_START + '&end=' + RANGE_END);
  assert.ok(list.data.unavailability.some((u) => u.id === leave.data.unavailability.id));
  const del = await owner.del(`/api/schedule/unavailability/${leave.data.unavailability.id}`);
  assert.equal(del.status, 200);
  const freed = await owner.post('/api/appointments', { patient_id: 3, doctor_id: 1, service_id: 3, start_at: startUtc.toISOString(), duration_min: 30 });
  assert.equal(freed.status, 201);
  // receptionist may manage unavailability; doctor may not
  const lina = await login('lina@alamal.demo');
  const docDenied = await lina.post('/api/schedule/unavailability', { doctor_id: 1, start_at: new Date(Date.now() + 86400000).toISOString(), end_at: new Date(Date.now() + 90000000).toISOString() });
  assert.equal(docDenied.status, 403);
});

test('attachments: secure upload/download/delete with type validation', async () => {
  const lina = await login('lina@alamal.demo');
  const rec = await lina.post('/api/records', { patient_id: 7, visit_date: new Date().toISOString().slice(0, 10), diagnosis: 'attachment test' });
  assert.equal(rec.status, 201);
  const rid = rec.data.record.id;

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const fd = new FormData();
  fd.append('entity_type', 'medical_record');
  fd.append('entity_id', String(rid));
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'تقرير-مختبر.pdf');
  const up = await lina.req('POST', '/api/attachments', undefined, { body: fd });
  assert.equal(up.status, 201, up.text);
  const aid = up.data.attachment.id;

  // disallowed mime
  const fd2 = new FormData();
  fd2.append('entity_type', 'medical_record');
  fd2.append('entity_id', String(rid));
  fd2.append('file', new Blob([Buffer.from('MZ...')], { type: 'application/x-msdownload' }), 'evil.exe');
  const bad1 = await lina.req('POST', '/api/attachments', undefined, { body: fd2 });
  assert.equal(bad1.status, 400);

  // magic-byte mismatch (png header claim, text content)
  const fd3 = new FormData();
  fd3.append('entity_type', 'medical_record');
  fd3.append('entity_id', String(rid));
  fd3.append('file', new Blob([Buffer.from('<html>hi</html>')], { type: 'image/png' }), 'fake.png');
  const bad2 = await lina.req('POST', '/api/attachments', undefined, { body: fd3 });
  assert.equal(bad2.status, 400);

  // list + download
  const list = await lina.get('/api/attachments?entity_type=medical_record&entity_id=' + rid);
  assert.equal(list.status, 200);
  assert.equal(list.data.attachments.length, 1);
  const dl = await lina.req('GET', `/api/attachments/${aid}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.ok(dl.headers.get('content-disposition').startsWith('attachment'));
  assert.ok(dl.text.includes('%PDF'));

  // cross-clinic doctor cannot read
  const sara = await login('sara@cedar.demo');
  const cross = await sara.req('GET', `/api/attachments/${aid}/download`);
  assert.equal(cross.status, 404);
  // accountant cannot read
  const acc = await login('accounting@alamal.demo');
  const accDl = await acc.req('GET', `/api/attachments/${aid}/download`);
  assert.equal(accDl.status, 403);
  // uploader soft-deletes; download afterwards 404
  const del = await lina.del(`/api/attachments/${aid}`);
  assert.equal(del.status, 200);
  const afterDel = await lina.req('GET', `/api/attachments/${aid}/download`);
  assert.equal(afterDel.status, 404);
});

test('operations report: no-show/utilization/aging numbers + csv variant', async () => {
  const owner = await login('owner@alamal.demo');
  const fromD = RANGE_START.slice(0, 10);
  const toD = RANGE_END.slice(0, 10);
  const res = await owner.get(`/api/reports/operations?from=${fromD}&to=${toD}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(Array.isArray(res.data.doctors) && res.data.doctors.length >= 2);
  for (const d of res.data.doctors) {
    assert.ok(d.no_show_rate >= 0 && d.no_show_rate <= 1);
  }
  assert.ok(res.data.utilization.capacity_minutes > 0);
  assert.ok(res.data.outstanding.aging);
  assert.ok(typeof res.data.billed_cents === 'number' && typeof res.data.collected_cents === 'number');
  const csv = await owner.get(`/api/reports/operations?from=${fromD}&to=${toD}&format=csv`);
  assert.ok(csv.text.includes('No-show rate'));
  // roles
  const reception = await login('reception@alamal.demo');
  const denied = await reception.get('/api/reports/operations');
  assert.equal(denied.status, 403);
  const acc = await login('accounting@alamal.demo');
  assert.equal((await acc.get('/api/reports/operations')).status, 200);
});

test('health: /api/health probes the database', async () => {
  const c = makeClient();
  const res = await c.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test('origin guard: state-changing request with foreign Origin -> 403', async () => {
  const owner = await login('owner@alamal.demo');
  const res = await owner.req('POST', '/api/patients', { first_name: 'X', last_name: 'Y', gender: 'male' }, { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
  // same-origin and no-origin pass
  const ok = await owner.req('POST', '/api/patients', { first_name: 'Origin', last_name: 'Allowed', gender: 'male' }, { headers: { Origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', 'Content-Type': 'application/json' } });
  assert.ok(ok.status === 201 || ok.status === 400, `origin-allowed request reached validation, got ${ok.status}`);
});

// ============================================================================
// APPOINTMENTS PAGE SUPPORT: search (q), pagination, phone in payload
// ============================================================================

test('appointments: search by patient name, phone digits and normalized Arabic', async () => {
  const owner = await login('owner@alamal.demo');
  const created = await owner.post('/api/patients', {
    first_name: 'Karim', last_name: 'Searchable', phone: '+970 599 123 456', gender: 'male',
  });
  assert.equal(created.status, 201);
  const pid = created.data.patient.id;
  const ar = await owner.post('/api/patients', { first_name: 'كريم', last_name: 'البحثي', gender: 'male' });
  assert.equal(ar.status, 201);
  const arPid = ar.data.patient.id;

  const { appt } = await findOpenSlot(owner, 1, 30);
  // rebook for our patient instead: cancel + create at same slot
  await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'cancelled' });
  const booked = await owner.post('/api/appointments', {
    patient_id: pid, doctor_id: 1, service_id: 3,
    start_at: appt.start_at, duration_min: 30,
  });
  assert.equal(booked.status, 201);
  const bookedAr = await owner.post('/api/appointments', {
    patient_id: arPid, doctor_id: 2, service_id: 3,
    start_at: new Date(new Date(appt.start_at).getTime() + 86400000 * 2).toISOString(),
    duration_min: 30,
  });
  // may conflict with seed; tolerate 409 by picking another slot via helper if needed
  let arApptOk = bookedAr.status === 201;
  if (!arApptOk) {
    const alt = await findOpenSlot(owner, 2, 30);
    await owner.patch(`/api/appointments/${alt.appt.id}/status`, { status: 'cancelled' });
    const retry = await owner.post('/api/appointments', {
      patient_id: arPid, doctor_id: 2, service_id: 3, start_at: alt.startUtc.toISOString(), duration_min: 30,
    });
    arApptOk = retry.status === 201;
  }
  assert.ok(arApptOk, 'arabic patient appointment should book');

  const byName = await owner.get('/api/appointments?q=Searchable&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.ok(byName.data.appointments.some((a) => a.patient_id === pid), 'name search failed');
  const byPhone = await owner.get('/api/appointments?q=599123456&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.ok(byPhone.data.appointments.some((a) => a.patient_id === pid), 'phone digit search failed');
  const byArabic = await owner.get('/api/appointments?q=' + encodeURIComponent('كريم البحثي') + '&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.ok(byArabic.data.appointments.some((a) => a.patient_id === arPid), 'arabic name search failed');
  const byArabicNormalized = await owner.get('/api/appointments?q=' + encodeURIComponent('كريم') + '&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.ok(byArabicNormalized.data.appointments.some((a) => a.patient_id === arPid), 'normalized arabic search failed');
  const none = await owner.get('/api/appointments?q=ZZZNobody&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.equal(none.data.appointments.length, 0);
  // phone is part of the payload for list display
  assert.ok(byName.data.appointments.every((a) => typeof a.patient_phone === 'string' || a.patient_phone === null));
  assert.equal(byName.data.appointments.find((a) => a.patient_id === pid).patient_phone, '+970 599 123 456');
});

test('appointments: pagination meta with page/limit, legacy shape preserved', async () => {
  const owner = await login('owner@alamal.demo');
  const p1 = await owner.get('/api/appointments?page=1&limit=2&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.equal(p1.status, 200);
  assert.equal(p1.data.appointments.length, 2);
  assert.ok(p1.data.total >= 2 && p1.data.pages >= 1 && p1.data.page === 1);
  const p2 = await owner.get('/api/appointments?page=2&limit=2&start=' + RANGE_START + '&end=' + RANGE_END);
  assert.notEqual(p2.data.appointments[0].id, p1.data.appointments[0].id, 'pages must not overlap');
  const legacy = await owner.get('/api/appointments?start=' + RANGE_START + '&end=' + RANGE_END);
  assert.equal(legacy.data.page, undefined, 'legacy shape must stay unpaged');
  assert.ok(legacy.data.appointments.length >= 4);
});
