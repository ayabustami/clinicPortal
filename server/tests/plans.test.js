'use strict';
/**
 * Treatment plans, sessions, waiting list, next-appointment booking,
 * dental-chart integrity, financial net-balances and concurrency tests.
 *
 * node:test + fetch against a real server instance on a throwaway PG database.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('plans');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const { wallToUtc } = require('../src/util/time');
const db = require('../src/db');

let server;
let baseUrl;
const TZ = 'Asia/Hebron';

function makeClient() {
  let cookie = null;
  const client = {
    async req(method, urlPath, body) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, data, text };
    },
    get: (p) => client.req('GET', p),
    post: (p, b) => client.req('POST', p, b),
    put: (p, b) => client.req('PUT', p, b),
    patch: (p, b) => client.req('PATCH', p, b),
    del: (p) => client.req('DELETE', p),
  };
  return client;
}

async function login(email) {
  const c = makeClient();
  const res = await c.post('/api/auth/login', { email, password: 'Demo1234!' });
  assert.equal(res.status, 200, `login ${email}`);
  return c;
}

/** Find an open slot for a doctor in the next 21 days (clinic working hours). */
async function openSlot(client, doctorId, patientId, { durationMin = 30, fromDay = 1 } = {}) {
  const boot = await client.get('/api/meta/bootstrap');
  const workingHours = boot.data.clinic.working_hours || {};
  for (let d = fromDay; d < fromDay + 21; d += 1) {
    const day = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const win = workingHours[String(weekday)];
    if (!win) continue; // clinic closed that day
    for (const hour of ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00']) {
      if (hour < win.start || hour >= win.end) continue;
      const startUtc = wallToUtc(`${day} ${hour}`, TZ);
      const res = await client.post('/api/appointments', {
        patient_id: patientId, doctor_id: doctorId, service_id: 3,
        start_at: startUtc.toISOString(), duration_min: durationMin,
      });
      if (res.status === 201) return { appt: res.data.appointment, startUtc, day, hour };
    }
  }
  throw new Error('no open slot found');
}

/** Probe (without booking) a slot with no overlap for the doctor. */
async function probeFreeSlot(client, doctorId, { durationMin = 40, fromDay = 1 } = {}) {
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const busy = await client.get(`/api/appointments?doctor_id=${doctorId}&start=${start}&end=${end}`);
  const taken = (busy.data.appointments || [])
    .filter((a) => !['cancelled', 'no_show'].includes(a.status))
    .map((a) => [new Date(a.start_at).getTime(), new Date(a.start_at).getTime() + a.duration_min * 60000]);
  const boot = await client.get('/api/meta/bootstrap');
  const workingHours = boot.data.clinic.working_hours || {};
  for (let d = fromDay; d < fromDay + 21; d += 1) {
    const day = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const win = workingHours[String(weekday)];
    if (!win) continue; // clinic closed that day
    for (const hour of ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00']) {
      if (hour < win.start || hour >= win.end) continue;
      const s0 = wallToUtc(`${day} ${hour}`, TZ).getTime();
      const e0 = s0 + durationMin * 60000;
      if (!taken.some(([ts, te]) => s0 < te && e0 > ts)) return new Date(s0);
    }
  }
  throw new Error('no free slot probe');
}

test.before(async () => {
  await createTestDb('plans');
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await seedMain();
});

test.after(async () => {
  server?.close();
  await db.closeDb();
  await destroyTestDb('plans');
});

let owner; let reception; let doctor;
let patientId; let doctorId; let servicePrice;

test('setup: logins and catalog', async () => {
  owner = await login('owner@alamal.demo');
  reception = await login('reception@alamal.demo');
  doctor = await login('lina@alamal.demo');
  const docs = await owner.get('/api/staff/doctors');
  doctorId = docs.data.doctors.find((d) => d.is_active).id;
  const svcs = await owner.get('/api/services');
  const svc = svcs.data.services.find((s) => s.id === 3) || svcs.data.services.find((s) => s.is_active);
  servicePrice = svc.price_cents;
  const pats = await owner.get('/api/patients?limit=5');
  patientId = pats.data.items[0].id;
  assert.ok(doctorId && patientId && servicePrice > 0);
});

/* ------------------------- treatment plan lifecycle ------------------------ */

let planId; let sessionA; let sessionB; let itemTooth; let itemPlain;

test('plans: create plan with items + sessions, totals from catalog', async () => {
  const res = await doctor.post('/api/plans', {
    patient_id: patientId,
    title: 'Restorative phase',
    responsible_doctor_id: doctorId,
    priority: 'high',
    sessions: [{ title: 'Session 1' }, { title: 'Session 2' }],
    items: [
      { procedure_label: 'Composite filling', service_id: 3, tooth_number: 12, surfaces: 'M', session_index: 0 },
      { procedure_label: 'Consultation', service_id: 3, session_index: 1 },
    ],
  });
  assert.equal(res.status, 201, res.text);
  const plan = res.data.plan;
  planId = plan.id;
  assert.equal(plan.status, 'draft');
  assert.equal(plan.sessions.length, 2);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].price_cents, servicePrice, 'price defaults from service catalog');
  assert.equal(plan.estimated_gross_cents, servicePrice * 2);
  assert.equal(plan.estimated_total_cents, servicePrice * 2);
  sessionA = plan.sessions[0].id;
  sessionB = plan.sessions[1].id;
  itemTooth = plan.items[0].id;
  itemPlain = plan.items[1].id;
});

test('plans: receptionist cannot create or approve plans', async () => {
  const res = await reception.post('/api/plans', { patient_id: patientId, title: 'nope', items: [] });
  assert.equal(res.status, 403);
  const ap = await reception.post(`/api/plans/${planId}/approve`, {});
  assert.equal(ap.status, 403);
});

test('plans: submit + approve flips item states', async () => {
  assert.equal((await doctor.post(`/api/plans/${planId}/submit`, {})).status, 200);
  assert.equal((await doctor.post(`/api/plans/${planId}/approve`, {})).status, 200);
  const got = await owner.get(`/api/plans/${planId}`);
  assert.equal(got.data.plan.status, 'approved');
  assert.ok(got.data.plan.items.every((i) => i.status === 'approved'));
  assert.ok(got.data.plan.approved_by);
});

test('plans: creating/approving a plan never touches the dental chart', async () => {
  const chart = await doctor.get(`/api/patients/${patientId}/dental`);
  assert.equal(chart.status, 200);
  const tooth12 = chart.data.findings.filter((f) => f.tooth_number === 12 && f.status === 'active');
  assert.equal(tooth12.length, 0, 'no chart findings were invented by plan creation');
});

test('plans: move item between sessions (split/re-group)', async () => {
  const res = await doctor.put(`/api/plans/${planId}/items/${itemPlain}`, { session_id: sessionA });
  assert.equal(res.status, 200, res.text);
  const moved = res.data.plan.items.find((i) => i.id === itemPlain);
  assert.equal(moved.session_id, sessionA);
  assert.equal(res.data.plan.sessions.find((s) => s.id === sessionA).item_count, 2);
  // move it back for the session-completion scenario
  await doctor.put(`/api/plans/${planId}/items/${itemPlain}`, { session_id: sessionB });
});

/* ---------------- book next appointment linked to a session ---------------- */

let linkedAppt;

test('next-appointment: booking with treatment_session_id links + schedules session', async () => {
  const startUtc = await probeFreeSlot(doctor, doctorId, { durationMin: 40 });
  // simulate "completed visit" context: a doctor books the next appointment
  const res = await doctor.post('/api/appointments', {
    patient_id: patientId, doctor_id: doctorId, service_id: 3,
    start_at: startUtc.toISOString(), duration_min: 40,
    appointment_type: 'procedure', treatment_session_id: sessionA,
  });
  assert.equal(res.status, 201, res.text);
  linkedAppt = res.data.appointment;
  assert.equal(linkedAppt.appointment_type, 'procedure');
  assert.equal(linkedAppt.treatment_session_id, sessionA);
  const plan = await owner.get(`/api/plans/${planId}`);
  const sess = plan.data.plan.sessions.find((s) => s.id === sessionA);
  assert.equal(sess.status, 'scheduled');
  assert.equal(sess.appointment_id, linkedAppt.id);
  assert.equal(plan.data.plan.status, 'in_progress');
});

test('next-appointment: same session cannot get a second active appointment', async () => {
  const startUtc = await probeFreeSlot(doctor, doctorId, { durationMin: 30, fromDay: 3 });
  const res = await doctor.post('/api/appointments', {
    patient_id: patientId, doctor_id: doctorId, service_id: 3,
    start_at: startUtc.toISOString(), duration_min: 30, treatment_session_id: sessionA,
  });
  assert.equal(res.status, 400, 'session already scheduled');
});

test('appointments: calendar range and patient list show the same booking', async () => {
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 30 * 86400000).toISOString();
  const cal = await owner.get(`/api/appointments?start=${start}&end=${end}`);
  const mine = cal.data.appointments.filter((a) => a.id === linkedAppt.id);
  assert.equal(mine.length, 1);
  const list = await owner.get(`/api/appointments?patient_id=${patientId}`);
  assert.ok(list.data.appointments.some((a) => a.id === linkedAppt.id));
});

test('appointments: conflicting move is rejected and original kept', async () => {
  const other = await openSlot(doctor, doctorId, patientId, { durationMin: 30, fromDay: 5 });
  // book a second appointment, then try to move it onto linkedAppt's slot
  const second = await openSlot(doctor, doctorId, patientId, { durationMin: 30, fromDay: 8 });
  const clash = await doctor.put(`/api/appointments/${second.appt.id}`, {
    start_at: linkedAppt.start_at, duration_min: linkedAppt.duration_min,
  });
  assert.equal(clash.status, 409, clash.text);
  const after = await owner.get(`/api/appointments/${second.appt.id}`);
  assert.equal(after.data.appointment.start_at, second.appt.start_at, 'original unchanged');
  assert.ok(other.appt.id);
});

test('appointments: concurrent duplicate bookings — exactly one wins', async () => {
  // Probe a genuinely free slot instead of a hardcoded day offset: the seed
  // scatters appointments relative to "today", so a fixed +N day can collide
  // depending on the weekday the suite runs.
  const startUtc = await probeFreeSlot(doctor, doctorId, { durationMin: 30, fromDay: 13 });
  const body = { patient_id: patientId, doctor_id: doctorId, service_id: 3, start_at: startUtc.toISOString(), duration_min: 30 };
  const results = await Promise.all([
    doctor.post('/api/appointments', body),
    doctor.post('/api/appointments', body),
  ]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409], `one created one conflict, got ${codes}`);
});

/* --------------------- dental chart clinical integrity --------------------- */

let findingId; let treatmentId;

test('dental: document caries on tooth 12 (finding)', async () => {
  const res = await doctor.post(`/api/patients/${patientId}/dental/findings`, {
    tooth_number: 12, condition: 'caries', surfaces: ['M'], note: 'baseline caries',
  });
  assert.equal(res.status, 201, res.text);
  findingId = res.data.finding.id;
  const tooth = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  assert.ok(tooth.data.findings.some((f) => f.id === findingId && f.status === 'active'));
});

test('dental: proposed procedure does not change current condition', async () => {
  const before = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  const res = await doctor.post(`/api/patients/${patientId}/dental/treatments`, {
    tooth_number: 12, procedure: 'filling', surfaces: ['M'], note: 'planned restoration',
  });
  assert.equal(res.status, 201, res.text);
  treatmentId = res.data.treatment.id;
  const after = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  assert.deepEqual(
    after.data.findings.map((f) => f.id).sort(),
    before.data.findings.map((f) => f.id).sort(),
    'planning must not alter findings');
});

test('dental: duplicate planned treatment rejected', async () => {
  const res = await doctor.post(`/api/patients/${patientId}/dental/treatments`, {
    tooth_number: 12, procedure: 'filling', surfaces: ['M'],
  });
  assert.equal(res.status, 409);
});

test('dental: postponing a procedure does not update the tooth', async () => {
  const before = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  const res = await doctor.patch(`/api/patients/${patientId}/dental/treatments/${treatmentId}/status`, {
    status: 'postponed', reason: 'patient rescheduled',
  });
  assert.equal(res.status, 200, res.text);
  const after = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  assert.deepEqual(after.data.findings, before.data.findings, 'postpone must not touch findings');
  assert.equal(res.data.treatment.status, 'postponed');
  // reopen for the completion test
  await doctor.patch(`/api/patients/${patientId}/dental/treatments/${treatmentId}/status`, { status: 'planned' });
});

test('dental: completing with apply+resolve updates tooth and preserves history', async () => {
  const res = await doctor.patch(`/api/patients/${patientId}/dental/treatments/${treatmentId}/status`, {
    status: 'completed',
    completion_note: 'composite placed',
    apply: { condition: 'filled', surfaces: ['M'], note: 'restored after caries' },
    resolve: ['caries'],
  });
  assert.equal(res.status, 200, res.text);
  const tooth = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  const caries = tooth.data.findings.find((f) => f.id === findingId);
  assert.equal(caries.status, 'resolved', 'old caries preserved but resolved');
  assert.ok(tooth.data.findings.some((f) => f.condition === 'filled' && f.status === 'active'));
  const hist = await doctor.get(`/api/patients/${patientId}/dental/history`);
  const kinds = hist.data.events.map((e) => e.event_type);
  assert.ok(kinds.includes('finding_created'));
  assert.ok(kinds.includes('finding_resolved'));
  assert.ok(kinds.includes('treatment_completed'));
});

/* ----------------------- session completion rules -------------------------- */

test('sessions: tooth item cannot complete without completed chart treatment', async () => {
  // the completed chart treatment auto-linked to the open plan item (same patient+tooth)
  const linked = await doctor.get(`/api/plans/${planId}`);
  const toothItem = linked.data.plan.items.find((i) => i.id === itemTooth);
  assert.equal(toothItem.dental_treatment_id, treatmentId, 'chart completion links the plan item');
  // reset the treatment to planned: the link alone must not be enough
  await doctor.patch(`/api/patients/${patientId}/dental/treatments/${treatmentId}/status`, { status: 'planned', reason: 'test reset' });
  const res = await doctor.post(`/api/plans/${planId}/sessions/${sessionA}/complete`, {
    performed: [itemTooth],
  });
  assert.equal(res.status, 400, 'tooth item requires completed dental treatment');
  assert.match(res.data.error.message, /dental chart/i);
});

test('sessions: partial completion — one performed, one postponed', async () => {
  // complete the chart treatment again (with confirmation) so the link is valid
  const redo = await doctor.patch(`/api/patients/${patientId}/dental/treatments/${treatmentId}/status`, {
    status: 'completed', completion_note: 'redo for session test',
  });
  assert.equal(redo.status, 200, redo.text);
  const res = await doctor.post(`/api/plans/${planId}/sessions/${sessionA}/complete`, {
    performed: [itemTooth], note: 'session 1 done',
  });
  assert.equal(res.status, 200, res.text);
  const plan = res.data.plan;
  const sess = plan.sessions.find((s) => s.id === sessionA);
  assert.equal(sess.status, 'completed');
  const toothItem = plan.items.find((i) => i.id === itemTooth);
  const plainItem = plan.items.find((i) => i.id === itemPlain);
  assert.equal(toothItem.status, 'completed');
  assert.notEqual(plainItem.status, 'completed', 'unperformed item stays outstanding');
  assert.equal(plan.status, 'in_progress', 'plan not completed while items outstanding');
  assert.equal(plan.progress.completed_items, 1);
  assert.equal(plan.progress.percent, 50);
});

test('sessions: receptionist cannot complete sessions', async () => {
  const res = await reception.post(`/api/plans/${planId}/sessions/${sessionB}/complete`, { performed: [] });
  assert.equal(res.status, 403);
});

/* ----------------------------- waiting list -------------------------------- */

let waitingId;

test('waiting: add, duplicate guard, resolve by booking', async () => {
  const res = await reception.post('/api/waiting', { patient_id: patientId, doctor_id: doctorId, reason: 'wants earlier slot' });
  assert.equal(res.status, 201, res.text);
  waitingId = res.data.item.id;
  const dup = await reception.post('/api/waiting', { patient_id: patientId });
  assert.equal(dup.status, 400);
  const slot = await openSlot(reception, doctorId, patientId, { durationMin: 30, fromDay: 2 });
  const resolve = await reception.post(`/api/waiting/${waitingId}/resolve`, { status: 'booked', appointment_id: slot.appt.id });
  assert.equal(resolve.status, 200, resolve.text);
  assert.equal(resolve.data.item.status, 'booked');
  const list = await reception.get('/api/waiting?status=waiting');
  assert.ok(!list.data.items.some((i) => i.id === waitingId));
});

/* ------------------------------- financial -------------------------------- */

let invoiceId;

test('billing: invoice, partial payment, balance, final payment -> paid', async () => {
  const inv = await owner.post('/api/invoices', {
    patient_id: patientId,
    items: [{ description: 'Composite filling', quantity: 1, unit_price: (servicePrice / 100).toFixed(2) }],
  });
  assert.equal(inv.status, 201, inv.text);
  invoiceId = inv.data.invoice.id;
  const total = inv.data.invoice.total_cents;
  const half = Math.floor(total / 2);
  const p1 = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: (half / 100).toFixed(2), method: 'cash' });
  assert.equal(p1.status, 201);
  assert.equal(p1.data.invoice.status, 'partial');
  assert.equal(p1.data.invoice.balance_cents, total - half);
  const p2 = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: ((total - half) / 100).toFixed(2), method: 'card' });
  assert.equal(p2.status, 201);
  assert.equal(p2.data.invoice.status, 'paid');
  assert.equal(p2.data.invoice.balance_cents, 0);
});

test('billing: refund reopens balance; over-refund rejected; idempotency key', async () => {
  const refund = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: '50.00', method: 'cash', type: 'refund', reference: 'goodwill' });
  assert.equal(refund.status, 201, refund.text);
  assert.equal(refund.data.invoice.status, 'partial', 'refund reopens the invoice');
  const over = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: '99999.00', type: 'refund' });
  assert.equal(over.status, 400);
  const key = 'idem-test-1';
  const a = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: '10.00', method: 'cash', idempotency_key: key });
  assert.equal(a.status, 201);
  const b = await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: '10.00', method: 'cash', idempotency_key: key });
  assert.equal(b.status, 200);
  assert.equal(b.data.idempotent, true);
  assert.equal(b.data.payment_id, a.data.invoice.payments.find((p) => p.idempotency_key === key).id);
  const got = await owner.get(`/api/invoices/${invoiceId}`);
  const nets = got.data.invoice.payments.reduce((s, p) => s + (p.type === 'payment' ? p.amount_cents : -p.amount_cents), 0);
  assert.equal(got.data.invoice.paid_cents, nets);
});

test('billing: payments never change clinical state', async () => {
  const toothBefore = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  const planBefore = await owner.get(`/api/plans/${planId}`);
  await owner.post(`/api/invoices/${invoiceId}/payments`, { amount: '5.00', method: 'cash' });
  const toothAfter = await doctor.get(`/api/patients/${patientId}/dental/teeth/12`);
  const planAfter = await owner.get(`/api/plans/${planId}`);
  assert.deepEqual(toothAfter.data.findings, toothBefore.data.findings);
  assert.equal(planAfter.data.plan.status, planBefore.data.plan.status);
  assert.deepEqual(planAfter.data.plan.items.map((i) => i.status), planBefore.data.plan.items.map((i) => i.status));
});

/* ------------------------- dashboard & timeline ---------------------------- */

test('dashboard: waiting room / in-treatment / clinical tasks present per role', async () => {
  const o = await owner.get('/api/dashboard/summary');
  assert.ok(Array.isArray(o.data.waiting_now));
  assert.ok(Array.isArray(o.data.in_treatment));
  assert.ok(o.data.clinical_tasks && typeof o.data.clinical_tasks.draft_records === 'number');
  const r = await reception.get('/api/dashboard/summary');
  assert.equal(r.data.clinical_tasks, null, 'reception does not see clinical task queue');
  assert.ok(Array.isArray(r.data.waiting_now));
});

test('timeline: chronological linked events respect role gates', async () => {
  const o = await owner.get(`/api/patients/${patientId}/timeline`);
  assert.equal(o.status, 200);
  const kinds = new Set(o.data.events.map((e) => e.type));
  assert.ok(kinds.has('appointment'));
  assert.ok(kinds.has('plan'));
  assert.ok(kinds.has('dental'), 'owner (clinical) sees dental events');
  assert.ok(kinds.has('invoice'), 'owner (financial) sees financial events');
  for (const e of o.data.events) assert.ok(e.link, `every event links to its record (${e.type})`);
  const r = await reception.get(`/api/patients/${patientId}/timeline`);
  const rk = new Set(r.data.events.map((e) => e.type));
  assert.ok(!rk.has('dental') && !rk.has('invoice') && !rk.has('record'), 'reception sees no clinical/financial events');
});

test('audit: plan approval and refunds are recorded', async () => {
  const a = await owner.get('/api/audit?limit=100');
  const actions = a.data.items.map((i) => i.action);
  assert.ok(actions.includes('plan.approve'));
  assert.ok(actions.includes('payment.refund'));
  assert.ok(actions.includes('plan.session.completed'));
});
