'use strict';
/**
 * Regression tests for the performance/bug-fix overhaul:
 *  F — dentist invoice creation & price policy, payments stay financial-only
 *  G — services management owner-only (direct API bypass attempts)
 *  B — patient reference resolution (numeric id, MRN fallback, garbage 400)
 *  H — report endpoint contracts (shapes the client renders must exist)
 *  C — records lookup by appointment (visit detail backing endpoint)
 */
const test = require('node:test');
const assert = require('node:assert');

const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('regress');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const db = require('../src/db');

let server; let baseUrl;

function makeClient() {
  let cookie = null;
  return {
    async req(method, urlPath, body) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-json */ }
      return { status: res.status, data, text };
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b); },
    put(p, b) { return this.req('PUT', p, b); },
  };
}
async function login(email) {
  const c = makeClient();
  const r = await c.post('/api/auth/login', { email, password: 'Demo1234!' });
  assert.equal(r.status, 200, `login ${email}`);
  return c;
}

test.before(async () => {
  await createTestDb('regress');
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await seedMain();
});
test.after(async () => {
  server?.close();
  await db.closeDb();
  await destroyTestDb('regress');
});

let owner; let reception; let doctor; let accountant;
let patientId; let mrn;

test('setup', async () => {
  owner = await login('owner@alamal.demo');
  reception = await login('reception@alamal.demo');
  doctor = await login('lina@alamal.demo');
  accountant = await login('accounting@alamal.demo');
  const pats = await owner.get('/api/patients?limit=5');
  patientId = pats.data.items[0].id;
  mrn = pats.data.items[0].mrn;
});

/* --------------------------------- G -------------------------------- */
test('G: reception cannot create/edit services even via direct API', async () => {
  const post = await reception.post('/api/services', { name: 'Bypass attempt', duration_min: 30, price_cents: 1000 });
  assert.equal(post.status, 403);
  const list = await owner.get('/api/services');
  const svc = list.data.services[0];
  const put = await reception.put(`/api/services/${svc.id}`, { name: 'Hacked' });
  assert.equal(put.status, 403);
  const ownerPost = await owner.post('/api/services', { name: 'Owner-only svc', duration_min: 30, price: '10.00' });
  assert.equal(ownerPost.status, 201);
});

/* --------------------------------- F -------------------------------- */
test('F: dentist creates invoice, adjusts prices pre-payment, locked post-payment', async () => {
  const created = await doctor.post('/api/invoices', {
    patient_id: patientId,
    items: [{ description: 'Composite restoration', quantity: 1, unit_price: '120.00' }],
  });
  assert.equal(created.status, 201, created.text);
  const inv = created.data.invoice;
  assert.equal(Number(inv.total_cents), 12000);

  // price adjustment before any payment: allowed for the creating dentist
  const adj = await doctor.put(`/api/invoices/${inv.id}`, {
    items: [{ description: 'Composite restoration', quantity: 1, unit_price: '100.00' }],
  });
  assert.equal(adj.status, 200, adj.text);

  // reception still cannot even read invoices
  assert.equal((await reception.get(`/api/invoices/${inv.id}`)).status, 403);

  // payment by financial role, then price edits locked
  const pay = await accountant.post(`/api/invoices/${inv.id}/payments`, { amount: '50.00', method: 'cash' });
  assert.equal(pay.status, 201, pay.text);
  const locked = await doctor.put(`/api/invoices/${inv.id}`, {
    items: [{ description: 'Composite restoration', quantity: 1, unit_price: '1.00' }],
  });
  assert.equal(locked.status, 409, 'prices locked once payments exist');

  // dentist can never record payments or refunds
  const denied = await doctor.post(`/api/invoices/${inv.id}/payments`, { amount: '10.00', method: 'cash' });
  assert.equal(denied.status, 403);
});

/* --------------------------------- B -------------------------------- */
test('B: patient ref resolution — numeric, MRN fallback, garbage rejected', async () => {
  const byId = await owner.get(`/api/patients/${patientId}`);
  assert.equal(byId.status, 200);
  const byMrn = await owner.get(`/api/patients/${encodeURIComponent(mrn)}`);
  assert.equal(byMrn.status, 200, 'MRN resolves to the same patient');
  assert.equal(byMrn.data.patient.id, patientId);
  const garbage = await owner.get('/api/patients/abc');
  assert.equal(garbage.status, 400);
  assert.match(garbage.data.error.message, /whole number/);
  assert.equal(garbage.data.error.fields?.id, 'invalid');
  const missing = await owner.get('/api/patients/99999999');
  assert.equal(missing.status, 404);
  // timeline honors the same resolution
  const tl = await owner.get(`/api/patients/${encodeURIComponent(mrn)}/timeline`);
  assert.equal(tl.status, 200);
});

/* --------------------------------- H -------------------------------- */
test('H: report endpoints keep the shapes the client renders', async () => {
  const from = '2020-01-01'; const to = '2030-01-01';
  const appt = await owner.get(`/api/reports/appointments?from=${from}&to=${to}`);
  assert.equal(appt.status, 200);
  assert.ok(appt.data.by_status && typeof appt.data.by_status === 'object');
  assert.ok(appt.data.by_doctor && typeof appt.data.by_doctor === 'object');
  const rev = await owner.get(`/api/reports/revenue?from=${from}&to=${to}`);
  assert.equal(rev.status, 200);
  assert.ok(rev.data.by_method && typeof rev.data.by_method === 'object');
  assert.ok(Array.isArray(rev.data.payments));
  const ops = await owner.get(`/api/reports/operations?from=${from}&to=${to}`);
  assert.equal(ops.status, 200);
  assert.ok(ops.data.utilization && Array.isArray(ops.data.doctors));
  const np = await owner.get(`/api/reports/patients?from=${from}&to=${to}`);
  assert.equal(np.status, 200);
  assert.ok(Array.isArray(np.data.patients));
  assert.equal(typeof np.data.total, 'number');
  // empty range -> meaningful empty payload, not a crash shape
  const empty = await owner.get('/api/reports/patients?from=2020-01-01&to=2020-01-02');
  assert.equal(empty.status, 200);
  assert.equal(empty.data.total, 0);
  assert.deepEqual(empty.data.patients, []);
});

/* --------------------------------- C -------------------------------- */
test('C: records can be fetched per appointment for visit details', async () => {
  const appts = await owner.get(`/api/appointments?patient_id=${patientId}&limit=5`);
  const appt = appts.data.appointments[0];
  const res = await owner.get(`/api/records?patient_id=${patientId}&appointment_id=${appt.id}&limit=5`);
  assert.equal(res.status, 200);
  for (const r of res.data.records) assert.equal(r.appointment_id, appt.id);
});

/* -------------------------- plan item rules ------------------------- */
test('D: timeline filters (types/from/to) are applied server-side', async () => {
  const all = await owner.get(`/api/patients/${patientId}/timeline?limit=300`);
  assert.equal(all.status, 200, all.text);
  assert.ok(all.data.events.length > 0, 'timeline should have seeded events');
  const inv = await owner.get(`/api/patients/${patientId}/timeline?types=invoice,payment`);
  assert.equal(inv.status, 200, inv.text);
  assert.ok(inv.data.events.every((e) => ['invoice', 'payment'].includes(e.type)), 'type filter leaked events');
  const future = await owner.get(`/api/patients/${patientId}/timeline?from=2030-01-01`);
  assert.equal(future.status, 200, future.text);
  assert.equal(future.data.events.length, 0, 'future from= must yield empty log');
  const past = await owner.get(`/api/patients/${patientId}/timeline?to=2000-01-01`);
  assert.equal(past.status, 200);
  assert.equal(past.data.events.length, 0, 'past to= must yield empty log');
  const bad = await owner.get(`/api/patients/${patientId}/timeline?from=notadate`);
  assert.equal(bad.status, 400, 'garbage from= rejected');
});

test('E: duplicate plan items rejected; quantity affects totals', async () => {
  const svcs = await owner.get('/api/services');
  const svc = svcs.data.services.find((s) => s.is_active);
  const created = await owner.post('/api/plans', {
    patient_id: patientId, title: 'Regression plan',
    items: [{ service_id: svc.id, procedure_label: svc.name, tooth_number: 36, quantity: 2, priority: 'high', price_cents: 5000 }],
  });
  assert.equal(created.status, 201, created.text);
  const plan = created.data.plan;
  assert.equal(Number(plan.estimated_gross_cents), 10000, 'qty 2 x 5000');
  const item36 = plan.items.find((i) => i.tooth_number === 36);
  assert.equal(item36.priority, 'high');
  assert.equal(Number(item36.line_total_cents), 10000, 'serialized line total');
  // priority/quantity updates via PUT, and invalid priority rejected
  const upd = await owner.put(`/api/plans/${plan.id}/items/${item36.id}`, { quantity: 3, priority: 'urgent' });
  assert.equal(upd.status, 200, upd.text);
  const it2 = upd.data.plan.items.find((i) => i.id === item36.id);
  assert.equal(Number(it2.quantity), 3);
  assert.equal(it2.priority, 'urgent');
  assert.equal(Number(upd.data.plan.estimated_gross_cents), 15000, 'total follows qty');
  const badPrio = await owner.put(`/api/plans/${plan.id}/items/${item36.id}`, { priority: 'whenever' });
  assert.equal(badPrio.status, 400, 'invalid priority rejected');
  const back = await owner.put(`/api/plans/${plan.id}/items/${item36.id}`, { quantity: 2, priority: 'high' });
  assert.equal(back.status, 200);
  const dup = await owner.post(`/api/plans/${plan.id}/items`, {
    service_id: svc.id, procedure_label: svc.name, tooth_number: 36,
  });
  assert.equal(dup.status, 400, 'exact duplicate item rejected');
  assert.match(dup.data.error.message, /already on the plan/i);
  const badQty = await owner.post(`/api/plans/${plan.id}/items`, {
    service_id: svc.id, procedure_label: 'x', quantity: 0, tooth_number: 37,
  });
  assert.equal(badQty.status, 400);
});
