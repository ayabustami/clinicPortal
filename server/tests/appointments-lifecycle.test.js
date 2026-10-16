'use strict';
/**
 * Stage K appointment-lifecycle tests: the validated booking -> arrival ->
 * clinical-visit machine, cancellation metadata, reschedule/status history,
 * booking sources, arrival/source filters, real summary counts, invoice
 * idempotency and concurrent-booking serialization. Throwaway PG database.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('apptlife');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const { wallToUtc } = require('../src/util/time');

let server;
let baseUrl;

function client() {
  let cookie = null;
  async function req(method, p, body) {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b),
  };
}

async function login(email, password = 'Demo1234!') {
  const c = client();
  const res = await c.post('/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return c;
}

/** Book the next free slot for a doctor by probing real server validation. */
async function book(owner, { doctorId = 1, patientId = 1, hour = '09:00', source } = {}) {
  for (let day = 1; day <= 21; day += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + day);
    const wall = `${d.toISOString().slice(0, 10)}T${hour}`;
    const res = await owner.post('/api/appointments', {
      patient_id: patientId, doctor_id: doctorId, service_ids: [1],
      start_at: wallToUtc(wall, 'Asia/Hebron').toISOString(),
      ...(source ? { booking_source: source } : {}),
    });
    if (res.status === 201) return res.data.appointment;
  }
  throw new Error('no free slot found in 21 days');
}

const patch = (c, id, body) => c.patch(`/api/appointments/${id}/status`, body);

test.before(async () => {
  await createTestDb();
  await seedMain();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await destroyTestDb();
});

test('lifecycle: illegal transitions are rejected with 400', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  assert.equal((await patch(owner, a.id, { status: 'completed' })).status, 400, 'scheduled->completed must be rejected');
  assert.equal((await patch(owner, a.id, { status: 'in_progress' })).status, 400, 'scheduled->in_progress must be rejected');
  const c = await patch(owner, a.id, { status: 'confirmed' });
  assert.equal(c.status, 200);
  assert.equal((await patch(owner, a.id, { status: 'in_progress' })).status, 400, 'confirmed->in_progress must be rejected');
  const ci = await patch(owner, a.id, { status: 'checked_in' });
  assert.equal(ci.status, 200);
  assert.equal((await patch(owner, a.id, { status: 'no_show' })).status, 400, 'arrived patient can never become no-show');
  const ip = await patch(owner, a.id, { status: 'in_progress' });
  assert.equal(ip.status, 200);
  assert.equal((await patch(owner, a.id, { status: 'no_show' })).status, 400, 'started visit can never become no-show');
  const done = await patch(owner, a.id, { status: 'completed' });
  assert.equal(done.status, 200);
  assert.equal((await patch(owner, a.id, { status: 'in_progress' })).status, 400, 'completed is terminal');
});

test('arrival and visit projections follow the machine, never free text', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  assert.equal(a.arrival_status, 'not_arrived');
  assert.equal(a.visit_status, 'not_started');
  await patch(owner, a.id, { status: 'checked_in' });
  let g = (await owner.get(`/api/appointments/${a.id}`)).data.appointment;
  assert.equal(g.arrival_status, 'arrived');
  assert.equal(g.visit_status, 'not_started', 'arrival must not start the clinical visit');
  await patch(owner, a.id, { status: 'in_progress' });
  g = (await owner.get(`/api/appointments/${a.id}`)).data.appointment;
  assert.equal(g.visit_status, 'in_progress');
  await patch(owner, a.id, { status: 'completed' });
  g = (await owner.get(`/api/appointments/${a.id}`)).data.appointment;
  assert.equal(g.visit_status, 'completed');
  assert.equal(g.arrival_status, 'arrived');
});

test('one-step visit: checked_in -> completed is allowed and completes the visit', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  assert.equal((await patch(owner, a.id, { status: 'checked_in' })).status, 200);
  const r = await patch(owner, a.id, { status: 'completed' });
  assert.equal(r.status, 200);
  assert.equal(r.data.appointment.visit_status, 'completed');
});

test('cancellation stores reason + timestamp; restore clears them and revalidates', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  const c = await patch(owner, a.id, { status: 'cancelled', reason: 'Patient travelled abroad' });
  assert.equal(c.status, 200);
  let g = (await owner.get(`/api/appointments/${a.id}`)).data.appointment;
  assert.equal(g.cancelled_reason, 'Patient travelled abroad');
  assert.ok(g.cancelled_at, 'cancelled_at must be set');
  const r = await patch(owner, a.id, { status: 'scheduled' });
  assert.equal(r.status, 200, 'restore must re-validate and succeed on a free slot');
  g = (await owner.get(`/api/appointments/${a.id}`)).data.appointment;
  assert.equal(g.cancelled_reason, null);
  assert.equal(g.cancelled_at, null);
});

test('history endpoint exposes reschedule + status + cancel events from the audit trail', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  // probe whole-week shifts (same weekday keeps working-hours validity) until
  // the target slot is free of seeded appointments for this doctor
  let put = null;
  for (const weeks of [1, 2, 3, 4]) {
    const moved = new Date(new Date(a.start_at).getTime() + weeks * 7 * 24 * 3600 * 1000);
    put = await owner.put(`/api/appointments/${a.id}`, { start_at: moved.toISOString() });
    if (put.status === 200) break;
  }
  assert.equal(put.status, 200, JSON.stringify(put.data));
  await patch(owner, a.id, { status: 'cancelled', reason: 'double booking elsewhere' });
  const h = await owner.get(`/api/appointments/${a.id}/history`);
  assert.equal(h.status, 200);
  const actions = h.data.events.map((e) => e.action);
  assert.ok(actions.includes('appointment.create'), 'create event');
  assert.ok(actions.includes('appointment.update'), 'reschedule event');
  const cancelEv = h.data.events.find((e) => e.action === 'appointment.status.cancelled');
  assert.ok(cancelEv && cancelEv.details.reason === 'double booking elsewhere', 'cancel reason in history');
  const upd = h.data.events.find((e) => e.action === 'appointment.update');
  assert.ok(upd.details.start_at.before && upd.details.start_at.after, 'reschedule keeps before/after');
  assert.ok(h.data.events.every((e) => e.actor), 'every event names its actor');
});

test('no-show only after the appointment time; terminal afterwards', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner);
  const early = await patch(owner, a.id, { status: 'no_show' });
  assert.equal(early.status, 400, 'future appointment cannot be no-show');
  // a past appointment: book yesterday by direct insert through PUT is blocked
  // for completed/cancelled only, so reuse validate path via status on a past slot
  const past = await owner.post('/api/appointments', {
    patient_id: 2, doctor_id: 2, service_ids: [1],
    start_at: wallToUtc(`${new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)}T09:00`, 'Asia/Hebron').toISOString(),
  });
  if (past.status === 201) {
    const ns = await patch(owner, past.data.appointment.id, { status: 'no_show' });
    assert.equal(ns.status, 200);
    const g = (await owner.get(`/api/appointments/${past.data.appointment.id}`)).data.appointment;
    assert.equal(g.arrival_status, 'no_show');
    assert.equal((await patch(owner, past.data.appointment.id, { status: 'confirmed' })).status, 400, 'no-show is terminal');
  }
});

test('booking source: default, explicit value and source filter', async () => {
  const owner = await login('owner@alamal.demo');
  const def = await book(owner);
  assert.equal(def.booking_source, 'reception');
  const phone = await book(owner, { patientId: 3, source: 'phone' });
  assert.equal(phone.booking_source, 'phone');
  const list = await owner.get('/api/appointments?source=phone&limit=500');
  assert.ok(list.data.appointments.some((x) => x.id === phone.id));
  assert.ok(!list.data.appointments.some((x) => x.id === def.id));
  assert.equal((await owner.get('/api/appointments?source=nonsense')).status, 400);
});

test('arrival filter + summary counts are real and clinic-day scoped', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner, { patientId: 4 });
  await patch(owner, a.id, { status: 'checked_in' });
  const arrived = await owner.get('/api/appointments?arrival=arrived&limit=500');
  assert.ok(arrived.data.appointments.some((x) => x.id === a.id));
  assert.ok(!arrived.data.appointments.some((x) => x.arrival_status !== 'arrived'));

  const dayIso = a.start_at; // same clinic day as the booking
  const sum = await owner.get(`/api/appointments/summary?date=${dayIso}`);
  assert.equal(sum.status, 200);
  assert.ok(sum.data.total >= 1);
  assert.ok(sum.data.by_arrival.arrived >= 1, 'summary must see the arrival');
  // another clinic day without bookings must report zero, not fabricate
  const empty = await owner.get('/api/appointments/summary?date=2030-01-01T00:00:00.000Z');
  assert.equal(empty.data.total, 0);
});

test('invoice creation for a visit is idempotent across retries', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner, { patientId: 5 });
  const payload = {
    patient_id: a.patient_id, appointment_id: a.id,
    items: [{ description: 'Cleaning', quantity: 1, unit_price: '120.00' }],
  };
  const first = await owner.post('/api/invoices', payload);
  assert.equal(first.status, 201);
  const listBefore = await owner.get(`/api/invoices?patient_id=${a.patient_id}&limit=100`);
  const second = await owner.post('/api/invoices', payload);
  assert.equal(second.status, 200, 'retry must replay, not duplicate');
  assert.equal(second.data.idempotent_replay, true);
  assert.equal(second.data.invoice.id, first.data.invoice.id);
  const listAfter = await owner.get(`/api/invoices?patient_id=${a.patient_id}&limit=100`);
  assert.equal(listAfter.data.invoices.length, listBefore.data.invoices.length,
    'retry must not mint a second invoice document');
  assert.equal(listAfter.data.total, listBefore.data.total);
});

test('dashboard schedule rows carry patient_id (Stage L connectivity fix)', async () => {
  const owner = await login('owner@alamal.demo');
  const d = await owner.get('/api/dashboard/summary');
  assert.equal(d.status, 200);
  const rows = [...(d.data.today.list || []), ...(d.data.upcoming.list || [])];
  assert.ok(rows.length, 'seed must provide schedule rows');
  for (const r of rows) assert.ok(Number.isInteger(r.patient_id), `row ${r.id} missing patient_id`);
});

test('treatment plan keeps the visit it was created from (migration 010)', async () => {
  const owner = await login('owner@alamal.demo');
  const a = await book(owner, { patientId: 12 });
  const plan = await owner.post('/api/plans', {
    patient_id: a.patient_id, title: 'Lifecycle link probe', appointment_id: a.id,
    items: [{ procedure_label: 'Composite filling', quantity: 1, tooth_number: 36 }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  assert.equal(plan.data.plan.appointment_id, a.id);
  const list = await owner.get(`/api/plans?patient_id=${a.patient_id}`);
  const mine = (list.data.plans || []).find((p) => p.id === plan.data.plan.id);
  assert.ok(mine && mine.appointment_id === a.id, 'plan list must expose the visit link');
});

test('concurrent bookings for the same doctor and slot: exactly one wins', async () => {
  const owner = await login('owner@alamal.demo');
  for (let off = 40; off <= 53; off += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + off);
    const start = wallToUtc(`${d.toISOString().slice(0, 10)}T09:00`, 'Asia/Hebron').toISOString();
    const mk = (pid) => owner.post('/api/appointments', { patient_id: pid, doctor_id: 1, service_ids: [1], start_at: start });
    const [r1, r2] = await Promise.all([mk(6), mk(7)]);
    const codes = [r1.status, r2.status].sort();
    if (codes[0] === 400 && codes[1] === 400) continue; // closed day: try next
    assert.deepEqual(codes, [201, 409], `expected one create + one conflict, got ${codes}`);
    return;
  }
  throw new Error('no open day found for concurrency probe');
});
