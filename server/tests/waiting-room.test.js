'use strict';
/**
 * Waiting Room tests: queue CRUD, duplicate-active prevention, appointment
 * check-in sync, no-show history preservation, status flow, doctor ownership
 * and clinic isolation. Throwaway PG database with the demo seed.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('waitroom');
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
    patch: (p, b) => req('PATCH', p, b),
  };
}

async function login(email, password = 'Demo1234!') {
  const c = client();
  const res = await c.post('/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.data)}`);
  return c;
}

async function pgQuery(sql, params = []) {
  const { Client } = require('pg');
  const pgc = new Client({ connectionString: process.env.DATABASE_URL });
  await pgc.connect();
  try { return await pgc.query(sql, params); } finally { await pgc.end(); }
}

/** Next free working slot for a doctor, scanning hours and days. */
async function findOpenSlot(owner, doctorId = 1, patientId = 3, preferredHour = '10:00') {
  const boot = await owner.get('/api/meta/bootstrap');
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
      const res = await owner.post('/api/appointments', {
        patient_id: patientId, doctor_id: doctorId, service_id: 3,
        start_at: startUtc.toISOString(), duration_min: 30,
      });
      if (res.status === 201) return res.data.appointment;
    }
  }
  throw new Error('Could not find an open slot in the next 21 days');
}

test.before(async () => {
  await createTestDb();
  await seedMain();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await destroyTestDb();
});

test('waiting room: receptionist adds a walk-in; duplicates and unauthorized roles rejected', async () => {
  const reception = await login('reception@alamal.demo');
  const add = await reception.post('/api/waiting-room', { patient_id: 5, doctor_id: 1, visit_type: 'new_visit', reason: 'Walk-in pain' });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.item.status, 'waiting');
  assert.ok(add.data.item.patient_name && add.data.item.patient_mrn && add.data.item.arrived_at);

  const dup = await reception.post('/api/waiting-room', { patient_id: 5, doctor_id: 2 });
  assert.equal(dup.status, 409);

  const list = await reception.get('/api/waiting-room');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.filter((i) => i.patient_id === 5).length, 1);

  const accounting = await login('accounting@alamal.demo');
  assert.equal((await accounting.get('/api/waiting-room')).status, 403);
  assert.equal((await accounting.post('/api/waiting-room', { patient_id: 5, doctor_id: 1 })).status, 403);

  const badPatient = await reception.post('/api/waiting-room', { patient_id: 999999, doctor_id: 1 });
  assert.equal(badPatient.status, 400);
});

test('waiting room: appointment check-in creates one linked entry and follows the visit', async () => {
  const owner = await login('owner@alamal.demo');
  const reception = await login('reception@alamal.demo');
  const appt = await findOpenSlot(owner, 2, 7);

  const checkin = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'checked_in' });
  assert.equal(checkin.status, 200, JSON.stringify(checkin.data));

  const list = await reception.get('/api/waiting-room');
  const entries = list.data.items.filter((i) => i.appointment_id === appt.id);
  assert.equal(entries.length, 1, 'check-in must create exactly one queue entry');
  assert.equal(entries[0].status, 'waiting');
  const entryId = entries[0].id;

  // check-in again is impossible by flow; ensure no second entry either way
  const again = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'checked_in' });
  assert.equal(again.status, 400);
  const list2 = await reception.get('/api/waiting-room');
  assert.equal(list2.data.items.filter((i) => i.appointment_id === appt.id).length, 1);

  const start = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'in_progress' });
  assert.equal(start.status, 200);
  const mid = await reception.get('/api/waiting-room?statuses=in_treatment');
  const midEntry = mid.data.items.find((i) => i.id === entryId);
  assert.ok(midEntry && midEntry.started_at, 'queue entry must follow into in_treatment');

  const done = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'completed' });
  assert.equal(done.status, 200);
  const fin = await reception.get('/api/waiting-room?statuses=completed');
  const finEntry = fin.data.items.find((i) => i.id === entryId);
  assert.ok(finEntry && finEntry.ended_at, 'queue entry must complete with the appointment');
});

test('waiting room: late arrival after a recorded no-show keeps the appointment history', async () => {
  const reception = await login('reception@alamal.demo');
  const owner = await login('owner@alamal.demo');
  const appt = await findOpenSlot(owner, 1, 9, '11:00');

  await pgQuery('UPDATE appointments SET start_at = start_at - interval \'3 days\' WHERE id = $1', [appt.id]);
  const ns = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'no_show' });
  assert.equal(ns.status, 200);

  const add = await reception.post('/api/waiting-room', {
    patient_id: appt.patient_id, doctor_id: appt.doctor_id,
    appointment_id: appt.id, visit_type: 'follow_up', reason: 'Arrived late, clinic agreed to see them',
  });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.item.appointment_status, 'no_show');

  const apptAfter = await owner.get(`/api/appointments/${appt.id}`);
  assert.equal(apptAfter.data.appointment.status, 'no_show', 'the booking record must keep its no-show history');
});

test('waiting room: status flow, timestamps and invalid transitions', async () => {
  const reception = await login('reception@alamal.demo');
  const add = await reception.post('/api/waiting-room', { patient_id: 11, doctor_id: 1 });
  assert.equal(add.status, 201);
  const id = add.data.item.id;

  const call = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'called' });
  assert.equal(call.status, 200);
  assert.ok(call.data.item.called_at);

  const back = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'waiting' });
  assert.equal(back.status, 200);

  const skip = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'in_treatment' });
  assert.equal(skip.status, 200);

  const invalid = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'waiting' });
  assert.equal(invalid.status, 400, 'in_treatment cannot go back to waiting');

  const complete = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'completed' });
  assert.equal(complete.status, 200);
  assert.ok(complete.data.item.ended_at);

  const reopen = await reception.patch(`/api/waiting-room/${id}/status`, { status: 'called' });
  assert.equal(reopen.status, 400, 'completed is terminal');

  // left path on a fresh entry
  const add2 = await reception.post('/api/waiting-room', { patient_id: 12, doctor_id: 1 });
  const left = await reception.patch(`/api/waiting-room/${add2.data.item.id}/status`, { status: 'left' });
  assert.equal(left.status, 200);
  assert.ok(left.data.item.ended_at);
  // a left patient can be re-added later (no active entry anymore)
  const reAdd = await reception.post('/api/waiting-room', { patient_id: 12, doctor_id: 1 });
  assert.equal(reAdd.status, 201);
});

test('waiting room: doctors manage only their own queue entries', async () => {
  const reception = await login('reception@alamal.demo');
  const lina = await login('lina@alamal.demo');
  const rows = await pgQuery("SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'lina@alamal.demo'");
  const linaDoctorId = rows.rows[0].id;
  const otherDoctorId = linaDoctorId === 1 ? 2 : 1;

  const mine = await reception.post('/api/waiting-room', { patient_id: 13, doctor_id: linaDoctorId });
  const theirs = await reception.post('/api/waiting-room', { patient_id: 14, doctor_id: otherDoctorId });
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);

  const okOwn = await lina.patch(`/api/waiting-room/${mine.data.item.id}/status`, { status: 'called' });
  assert.equal(okOwn.status, 200);
  const blocked = await lina.patch(`/api/waiting-room/${theirs.data.item.id}/status`, { status: 'called' });
  assert.equal(blocked.status, 403);
});

test('waiting room: clinic isolation holds', async () => {
  const cedar = await login('reception@cedar.demo');
  const list = await cedar.get('/api/waiting-room');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 0, 'cedar must not see al-amal queue entries');
  const cross = await cedar.post('/api/waiting-room', { patient_id: 5, doctor_id: 1 });
  assert.equal(cross.status, 400);
});
