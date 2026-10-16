'use strict';
/**
 * Stage G appointment-workflow tests: the no-show time rule, list sorting,
 * and MRN surfacing on list rows. Throwaway PG database, demo seed fixture.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('apptflow');
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
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.data)}`);
  return c;
}

/** Next free working slot for a doctor, scanning hours and days. */
async function findOpenSlot(owner, doctorId = 1, durationMin = 30, preferredHour = '10:00') {
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
        patient_id: 3, doctor_id: doctorId, service_id: 3,
        start_at: startUtc.toISOString(), duration_min: durationMin,
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

test('no-show: rejected while the appointment is still in the future', async () => {
  const owner = await login('owner@alamal.demo');
  const appt = await findOpenSlot(owner);
  const res = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'no_show' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.data), /no-show can only be recorded/i);
  const after = await owner.get(`/api/appointments/${appt.id}`);
  assert.equal(after.data.appointment.status, 'scheduled');
});

test('no-show: allowed once the appointment time has passed, and audited', async () => {
  const owner = await login('owner@alamal.demo');
  const appt = await findOpenSlot(owner, 1, 30, '11:00');

  // Move the appointment into the past on the throwaway test database only.
  const { Client } = require('pg');
  const pgc = new Client({ connectionString: process.env.DATABASE_URL });
  await pgc.connect();
  // Deterministic past-dating: the no-show guard only fires once the
  // appointment time has actually passed, whichever day the probe picked.
  await pgc.query('UPDATE appointments SET start_at = now() - interval \'1 hour\' WHERE id = $1', [appt.id]);
  await pgc.end();

  const res = await owner.patch(`/api/appointments/${appt.id}/status`, { status: 'no_show' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.appointment.status, 'no_show');

  const audit = await owner.get('/api/audit?action=appointment.status');
  const hit = (audit.data.entries || audit.data.items || []).find((e) => e.entity_id === appt.id && e.action === 'appointment.status.no_show');
  assert.ok(hit, 'status change must be present in the audit trail');
});

test('no-show: receptionist may record it after the time passes (scheduling role)', async () => {
  const reception = await login('reception@alamal.demo');
  const owner = await login('owner@alamal.demo');
  const appt = await findOpenSlot(owner, 2, 30, '09:30');
  const { Client } = require('pg');
  const pgc = new Client({ connectionString: process.env.DATABASE_URL });
  await pgc.connect();
  // Deterministic past-dating: the no-show guard only fires once the
  // appointment time has actually passed, whichever day the probe picked.
  await pgc.query('UPDATE appointments SET start_at = now() - interval \'1 hour\' WHERE id = $1', [appt.id]);
  await pgc.end();
  const res = await reception.patch(`/api/appointments/${appt.id}/status`, { status: 'no_show' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
});

test('list: sort options and invalid sort rejection', async () => {
  const owner = await login('owner@alamal.demo');
  const wide = `start=${new Date(Date.now() - 120 * 86400000).toISOString()}&end=${new Date(Date.now() + 120 * 86400000).toISOString()}`;

  const desc = await owner.get(`/api/appointments?${wide}&page=1&limit=20&sort=time_desc`);
  assert.equal(desc.status, 200);
  const times = desc.data.appointments.map((a) => a.start_at);
  assert.ok(times.every((t, i) => i === 0 || times[i - 1] >= t), 'time_desc must be descending');

  const asc = await owner.get(`/api/appointments?${wide}&page=1&limit=20&sort=time_asc`);
  const timesAsc = asc.data.appointments.map((a) => a.start_at);
  assert.ok(timesAsc.every((t, i) => i === 0 || timesAsc[i - 1] <= t), 'time_asc must be ascending');

  const byPatient = await owner.get(`/api/appointments?${wide}&page=1&limit=50&sort=patient`);
  const names = byPatient.data.appointments.map((a) => a.patient_name);
  assert.ok(names.every((n, i) => i === 0 || names[i - 1] <= n), 'patient sort must order by displayed patient name');

  const bad = await owner.get(`/api/appointments?${wide}&sort=drop-table`);
  assert.equal(bad.status, 400);
});

test('list: rows carry patient MRN for safe identification', async () => {
  const owner = await login('owner@alamal.demo');
  const wide = `start=${new Date(Date.now() - 120 * 86400000).toISOString()}&end=${new Date(Date.now() + 120 * 86400000).toISOString()}`;
  const res = await owner.get(`/api/appointments?${wide}&page=1&limit=10`);
  assert.equal(res.status, 200);
  assert.ok(res.data.appointments.length > 0);
  for (const a of res.data.appointments) {
    assert.ok(a.patient_mrn, `appointment ${a.id} must include patient_mrn`);
    assert.ok(a.patient_name && a.appointment_type);
  }
});
