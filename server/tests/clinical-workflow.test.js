'use strict';
/**
 * Stage I clinical-workflow tests: service catalog configuration, multi-service
 * bookings with price/duration snapshots, record finalization + amendment
 * history, and DB-level duplicate performed-procedure prevention.
 * Throwaway PG database with the demo seed. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('clworkflow');
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

async function pgQuery(sql, params = []) {
  const { Client } = require('pg');
  const pgc = new Client({ connectionString: process.env.DATABASE_URL });
  await pgc.connect();
  try { return await pgc.query(sql, params); } finally { await pgc.end(); }
}

/** Book the next free working slot; body may omit duration when service_ids drive it. */
async function bookSlot(owner, { patientId = 3, doctorId = 1, body = {}, preferredHour = '10:00' } = {}) {
  const boot = await owner.get('/api/meta/bootstrap');
  const { timezone, working_hours } = boot.data.clinic;
  const hours = [preferredHour, '08:30', '09:30', '10:30', '11:30', '13:30', '14:30', '15:30'];
  const today = new Date();
  let lastErr = null;
  for (let d = 1; d <= 21; d++) {
    const day = new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const win = working_hours[String(weekday)];
    if (!win) continue;
    for (const hour of hours) {
      if (hour < win.start || hour >= win.end) continue;
      const startUtc = wallToUtc(`${day} ${hour}`, timezone);
      const res = await owner.post('/api/appointments', {
        patient_id: patientId, doctor_id: doctorId, start_at: startUtc.toISOString(), ...body,
      });
      if (res.status === 201) return res.data.appointment;
      lastErr = res;
      if (res.status !== 409 && res.status !== 400) return assert.fail(`booking failed: ${JSON.stringify(res.data)}`);
    }
  }
  assert.fail(`Could not find an open slot: ${JSON.stringify(lastErr && lastErr.data)}`);
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

test('services: owner configures catalog workflow fields; other roles blocked', async () => {
  const owner = await login('owner@alamal.demo');
  const reception = await login('reception@alamal.demo');

  const put = await owner.put('/api/services/2', {
    category: 'Restorative',
    preparation: 'Review anesthesia options',
    provider_qualification: 'Dentist',
    requires_chart: true,
    requires_performed: true,
    bills_item: true,
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.service.category, 'Restorative');
  assert.equal(put.data.service.requires_chart, true);
  assert.equal(put.data.service.requires_performed, true);
  assert.equal(put.data.service.bills_item, true);
  assert.equal(typeof put.data.service.requires_encounter, 'boolean');

  const list = await reception.get('/api/services');
  assert.equal(list.status, 200);
  const s2 = list.data.services.find((s) => s.id === 2);
  assert.equal(s2.category, 'Restorative');

  const blocked = await reception.put('/api/services/2', { category: 'Hacked' });
  assert.equal(blocked.status, 403);
});

test('appointments: multi-service booking sums durations and snapshots prices; catalog edits never rewrite history', async () => {
  const owner = await login('owner@alamal.demo');
  const { services } = (await owner.get('/api/services')).data;
  const active = services.filter((s) => s.is_active).slice(0, 2);
  assert.ok(active.length >= 2, 'seed must provide at least two active services');
  const [sa, sb] = active;
  const sumDuration = sa.duration_min + sb.duration_min;

  const appt = await bookSlot(owner, { body: { service_ids: [sa.id, sb.id] } });
  assert.equal(appt.duration_min, sumDuration, 'booked duration must equal the sum of catalog durations');
  assert.equal(appt.service_id, sa.id, 'legacy service_id points at the first service');
  assert.equal(appt.services.length, 2);
  assert.deepEqual(appt.services.map((x) => x.service_id), [sa.id, sb.id]);
  assert.equal(appt.services[1].price_cents, sb.price_cents, 'price snapshot at booking time');

  const rows = await pgQuery('SELECT * FROM appointment_services WHERE appointment_id = $1 ORDER BY sequence', [appt.id]);
  assert.equal(rows.rowCount, 2);
  assert.equal(Number(rows.rows[1].price_cents), sb.price_cents);

  // Catalog price change AFTER booking must not touch the snapshot.
  const newPrice = sb.price_cents + 1000;
  const repriced = await owner.put(`/api/services/${sb.id}`, { price: newPrice / 100 });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.data));
  const fresh = await owner.get(`/api/appointments/${appt.id}`);
  const snap = fresh.data.appointment.services.find((x) => x.service_id === sb.id);
  assert.equal(snap.price_cents, sb.price_cents, 'booked appointment keeps its original price snapshot');

  // Deactivation: new bookings rejected, existing appointment keeps the service.
  const off = await owner.put(`/api/services/${sb.id}`, { is_active: false });
  assert.equal(off.status, 200);
  const rejected = await owner.post('/api/appointments', {
    patient_id: 4, doctor_id: 2, start_at: new Date(Date.now() + 6 * 86400000).toISOString(),
    service_ids: [sa.id, sb.id],
  });
  assert.equal(rejected.status, 400, `booking a deactivated service must fail, got ${rejected.status}`);
  assert.match(rejected.data.error.message, /deactivated/i);
  const stillThere = await owner.get(`/api/appointments/${appt.id}`);
  assert.equal(stillThere.data.appointment.services.length, 2, 'deactivation never erases booked history');

  // Duplicate service ids rejected.
  const dupBody = { service_ids: [sa.id, sa.id] };
  const boot = await owner.get('/api/meta/bootstrap');
  const dup = await owner.post('/api/appointments', {
    patient_id: 3, doctor_id: 1, start_at: new Date(Date.now() + 5 * 86400000).toISOString(), ...dupBody,
  });
  assert.equal(dup.status, 400, 'duplicate service_ids must be rejected');
  assert.ok(boot.status === 200);

  // Cleanup: reactivate so later tests/flows see a normal catalog.
  await owner.put(`/api/services/${sb.id}`, { is_active: true });
});

test('records: finalization stamps provenance; approved edits require a reason and build an amendment trail', async () => {
  const owner = await login('owner@alamal.demo');
  const today = new Date().toISOString().slice(0, 10);

  const created = await owner.post('/api/records', {
    patient_id: 3, doctor_id: 1, visit_date: today, status: 'draft',
    diagnosis: 'Initial diagnosis', examination: 'Visual exam',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.record.id;
  assert.equal(created.data.record.finalized_at, null, 'drafts are not finalized');

  // Drafts remain freely editable.
  const draftEdit = await owner.put(`/api/records/${id}`, { examination: 'Visual exam + percussion' });
  assert.equal(draftEdit.status, 200);

  // Finalize (draft -> approved) stamps finalized_at/by.
  const fin = await owner.put(`/api/records/${id}`, { status: 'approved' });
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.ok(fin.data.record.finalized_at, 'finalization must stamp finalized_at');
  assert.ok(fin.data.record.finalized_by, 'finalization must stamp finalized_by');

  // Approved content edits without a reason are rejected.
  const noReason = await owner.put(`/api/records/${id}`, { diagnosis: 'Silent rewrite' });
  assert.equal(noReason.status, 400, 'approved edits require amendment_reason');
  assert.equal(noReason.data.error.fields.amendment_reason, 'required');

  // Amendment with reason is applied, recorded, and keeps the record approved.
  const amend = await owner.put(`/api/records/${id}`, {
    diagnosis: 'Irreversible pulpitis (corrected)',
    amendment_reason: 'Diagnosis refined after vitality test',
  });
  assert.equal(amend.status, 200, JSON.stringify(amend.data));
  assert.equal(amend.data.record.status, 'approved');
  assert.equal(amend.data.record.diagnosis, 'Irreversible pulpitis (corrected)');

  const detail = await owner.get(`/api/records/${id}`);
  assert.equal(detail.status, 200);
  const ams = detail.data.record.amendments;
  assert.equal(ams.length, 1, 'exactly one amendment row');
  assert.equal(ams[0].reason, 'Diagnosis refined after vitality test');
  assert.equal(ams[0].amended_by_name, 'Salam Qasem');
  const changes = JSON.parse(ams[0].changes);
  assert.equal(changes.diagnosis.before, 'Initial diagnosis');
  assert.equal(changes.diagnosis.after, 'Irreversible pulpitis (corrected)');

  // A second amendment appends (history never overwritten).
  const amend2 = await owner.put(`/api/records/${id}`, { follow_up: 'RCT within a week', amendment_reason: 'Added follow-up plan' });
  assert.equal(amend2.status, 200);
  const detail2 = await owner.get(`/api/records/${id}`);
  assert.equal(detail2.data.record.amendments.length, 2);

  // Approved -> draft remains forbidden.
  const back = await owner.put(`/api/records/${id}`, { status: 'draft' });
  assert.equal(back.status, 400);
});

test('performed procedures: the same completed procedure cannot be recorded twice for one encounter', async () => {
  const owner = await login('owner@alamal.demo');
  const today = new Date().toISOString().slice(0, 10);

  const rec = await owner.post('/api/records', { patient_id: 5, doctor_id: 1, visit_date: today, status: 'draft' });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  const recordId = rec.data.record.id;

  const t1 = await owner.post('/api/patients/5/dental/treatments', {
    tooth_number: 36, procedure: 'filling', surfaces: ['O'], record_id: recordId,
  });
  assert.equal(t1.status === 201 || t1.status === 200, true, JSON.stringify(t1.data));
  const t1id = t1.data.treatment.id;

  const done1 = await owner.patch(`/api/patients/5/dental/treatments/${t1id}/status`, { status: 'completed', completion_note: 'Composite filling placed' });
  assert.equal(done1.status, 200, JSON.stringify(done1.data));

  // A second identical planned treatment is allowed (planned != performed)...
  const t2 = await owner.post('/api/patients/5/dental/treatments', {
    tooth_number: 36, procedure: 'filling', surfaces: ['O'], record_id: recordId,
  });
  assert.equal(t2.status === 201 || t2.status === 200, true, JSON.stringify(t2.data));
  const t2id = t2.data.treatment.id;

  // ...but completing it in the same encounter is a duplicate performed record.
  const done2 = await owner.patch(`/api/patients/5/dental/treatments/${t2id}/status`, { status: 'completed' });
  assert.equal(done2.status, 409, `duplicate completion must be rejected, got ${done2.status}: ${JSON.stringify(done2.data)}`);
  assert.match(done2.data.error.message, /already recorded as completed/i);

  const cnt = await pgQuery(
    "SELECT COUNT(*)::int AS c FROM dental_treatments WHERE record_id = $1 AND status = 'completed'", [recordId]);
  assert.equal(cnt.rows[0].c, 1, 'exactly one completed performed record remains');

  // A different tooth is unaffected.
  const t3 = await owner.post('/api/patients/5/dental/treatments', { tooth_number: 37, procedure: 'filling', surfaces: ['O'], record_id: recordId });
  assert.equal(t3.status === 201 || t3.status === 200, true, JSON.stringify(t3.data));
  const done3 = await owner.patch(`/api/patients/5/dental/treatments/${t3.data.treatment.id}/status`, { status: 'completed' });
  assert.equal(done3.status, 200, JSON.stringify(done3.data));
});
