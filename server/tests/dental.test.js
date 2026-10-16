'use strict';
/**
 * Dental chart (odontogram) API tests — node:test + fetch against a real
 * server instance backed by a throwaway SQLite DB seeded with the demo fixture.
 *
 * Covers: FDI numbering/counts, quadrant mapping, mixed dentition, findings
 * CRUD + surfaces, the three clinical layers (current / planned / completed),
 * chronological history, authorization, cross-clinic isolation, invalid input,
 * duplicate-submission guards, persistence across sessions, migration state.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

// Point the app at a throwaway PostgreSQL database BEFORE loading any module
// (the pg pool is created lazily, so this synchronous env swap is enough).
const { pointAtTestDb, createTestDb, destroyTestDb } = require('./helpers/pgTestDb');
pointAtTestDb('dental');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const seedMain = require('../src/seed').main;
const D = require('../src/services/dental');
const { pendingMigrations } = require('../src/migrate');
const db = require('../src/db');

let server;
let baseUrl;

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
  };
  return client;
}

async function login(email, password = 'Demo1234!') {
  const c = makeClient();
  const res = await c.post('/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.data)}`);
  return c;
}

/** First patient id visible to the given client (no hardcoded ids). */
async function firstPatientId(client) {
  const res = await client.get('/api/patients?limit=1');
  assert.equal(res.status, 200);
  const p = res.data.items[0];
  assert.ok(p, 'seed should provide at least one patient');
  return p.id;
}

test.before(async () => {
  await createTestDb();   // fresh derived database
  await seedMain();       // migrate + seed demo fixture
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await destroyTestDb();
});

/* ---------------- 1+2. FDI numbering, counts, quadrant mapping ---------------- */

test('dental: FDI numbering — counts, quadrants, dentition mapping', () => {
  assert.equal(D.PERMANENT_TEETH.length, 32);
  assert.equal(D.PRIMARY_TEETH.length, 20);
  assert.equal(D.VALID_TEETH.size, 52);
  // permanent quadrants: 1 UR 18-11, 2 UL 21-28, 3 LL 31-38, 4 LR 41-48
  for (const [q, positions] of [[1, 8], [2, 8], [3, 8], [4, 8]]) {
    for (let p = 1; p <= positions; p++) {
      const t = q * 10 + p;
      assert.ok(D.isValidTooth(t), `${t} should be valid`);
      assert.equal(D.toothDentition(t), 'permanent');
    }
  }
  // primary quadrants: 5-8, positions 1-5
  for (let q = 5; q <= 8; q++) {
    for (let p = 1; p <= 5; p++) {
      const t = q * 10 + p;
      assert.ok(D.isValidTooth(t), `${t} should be valid`);
      assert.equal(D.toothDentition(t), 'primary');
    }
    assert.ok(!D.isValidTooth(q * 10 + 6), `primary quadrant ${q} has no position 6`);
  }
  // invalid numbers
  for (const bad of [0, 10, 19, 49, 50, 56, 91, 99, 111, -16, 1.5]) {
    assert.ok(!D.isValidTooth(bad), `${bad} must be invalid`);
  }
  // specific anchors from the spec
  assert.ok([18, 11].every((t) => D.isValidTooth(t)));
  assert.ok([21, 28].every((t) => D.isValidTooth(t)));
  assert.ok([31, 38].every((t) => D.isValidTooth(t)));
  assert.ok([41, 48].every((t) => D.isValidTooth(t)));
  assert.ok([55, 51, 61, 65, 71, 75, 81, 85].every((t) => D.isValidTooth(t)));
});

test('dental: surfaces normalization', () => {
  assert.equal(D.normalizeSurfaces(null), '');
  assert.equal(D.normalizeSurfaces([]), '');
  assert.equal(D.normalizeSurfaces(['o', 'm', 'm']), 'M,O');
  assert.equal(D.normalizeSurfaces('D,M'), 'M,D');
  assert.throws(() => D.normalizeSurfaces(['X']), /not a valid surface/);
});

/* ---------------- 3. dentition suggestion + mixed dentition ---------------- */

test('dental: age-based dentition suggestion is relative, never stored as fact', () => {
  const yearsAgo = (n) => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d.toISOString().slice(0, 10);
  };
  assert.equal(D.suggestDentition(yearsAgo(4)), 'primary');
  assert.equal(D.suggestDentition(yearsAgo(9)), 'mixed');
  assert.equal(D.suggestDentition(yearsAgo(30)), 'permanent');
  assert.equal(D.suggestDentition(null), null);
  assert.equal(D.suggestDentition('not-a-date'), null);
});

/* ---------------- chart access + authorization (8) ---------------- */

test('dental: authorization — clinical roles only, admin has no clinic access', async () => {
  const owner = await login('owner@alamal.demo');
  const pid = await firstPatientId(owner);

  const reception = await login('reception@alamal.demo');
  const accountant = await login('accounting@alamal.demo');
  const r1 = await reception.get(`/api/patients/${pid}/dental`);
  const r2 = await accountant.get(`/api/patients/${pid}/dental`);
  assert.equal(r1.status, 403, 'receptionist must not read clinical chart');
  assert.equal(r2.status, 403, 'accountant must not read clinical chart');

  const anon = makeClient();
  assert.equal((await anon.get(`/api/patients/${pid}/dental`)).status, 401);

  // write attempts by non-clinical roles
  const w = await reception.post(`/api/patients/${pid}/dental/findings`, { tooth_number: 16, condition: 'caries' });
  assert.equal(w.status, 403);

  // doctor of the same clinic may read and write
  const doctor = await login('lina@alamal.demo');
  const ok = await doctor.get(`/api/patients/${pid}/dental`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.chart.persisted, false, 'no chart row before first write');
  assert.ok(['permanent', 'primary', 'mixed'].includes(ok.data.chart.dentition));
});

/* ---------------- 9. cross-clinic isolation ---------------- */

test('dental: cross-clinic access is prevented (same 404 as unknown ids)', async () => {
  const almal = await login('owner@alamal.demo');
  const cedar = await login('owner@cedar.demo');
  const alamalPid = await firstPatientId(almal);
  const cedarPid = await firstPatientId(cedar);
  assert.notEqual(alamalPid, cedarPid);

  // cedar owner reading almal's patient chart
  const r = await cedar.get(`/api/patients/${alamalPid}/dental`);
  assert.equal(r.status, 404);
  const w = await cedar.post(`/api/patients/${alamalPid}/dental/findings`, { tooth_number: 16, condition: 'caries' });
  assert.equal(w.status, 404);
  // almal reading cedar's patient
  assert.equal((await almal.get(`/api/patients/${cedarPid}/dental`)).status, 404);

  // entity id guessing: create a finding in cedar, then try to touch it as almal
  const ct = await cedar.post(`/api/patients/${cedarPid}/dental/findings`, { tooth_number: 26, condition: 'caries' });
  assert.equal(ct.status, 201);
  const findingId = ct.data.finding.id;
  const steal = await almal.put(`/api/patients/${alamalPid}/dental/findings/${findingId}`, { note: 'hijack' });
  assert.equal(steal.status, 404, 'finding of another clinic must not be reachable');
  const steal2 = await almal.post(`/api/patients/${alamalPid}/dental/findings/${findingId}/resolve`, { reason: 'x' });
  assert.equal(steal2.status, 404);
});

/* ---------------- 4+5+6+7+10+11. core clinical flow ---------------- */

test('dental: findings, surfaces, layers, history, validation, duplicates', async () => {
  const doctor = await login('lina@alamal.demo');
  const owner = await login('owner@alamal.demo');
  const pid = await firstPatientId(owner);
  const base = `/api/patients/${pid}/dental`;

  /* --- 10. invalid input --- */
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 19, condition: 'caries' })).status, 400);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 91, condition: 'caries' })).status, 400);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 'abc', condition: 'caries' })).status, 400);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 16 })).status, 400, 'missing condition');
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 16, condition: 'sparkly' })).status, 400);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 16, condition: 'caries', surfaces: ['X'] })).status, 400);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 16, condition: 'other' })).status, 400, '"other" needs a note');
  assert.equal((await doctor.get(`${base}/teeth/77`)).status, 400);
  assert.equal((await doctor.post(`${base}/treatments`, { tooth_number: 16, procedure: 'magic' })).status, 400);

  /* --- 4. create findings (multiple per tooth) --- */
  const caries = await doctor.post(`${base}/findings`, {
    tooth_number: 16, condition: 'caries', surfaces: ['O', 'M'], note: 'Deep occlusal caries',
  });
  assert.equal(caries.status, 201);
  assert.equal(caries.data.finding.tooth_number, 16);
  assert.equal(caries.data.finding.dentition, 'permanent');
  assert.deepEqual(caries.data.finding.surfaces, ['M', 'O'], 'surfaces normalized to catalog order');
  assert.equal(caries.data.finding.status, 'active');
  assert.equal(caries.data.finding.created_by_name, 'Dr. Lina Haddad');

  // crown + root canal on the same tooth must coexist (not mutually exclusive)
  const rct = await doctor.post(`${base}/findings`, { tooth_number: 11, condition: 'root_canal' });
  const crown = await doctor.post(`${base}/findings`, { tooth_number: 11, condition: 'crown' });
  assert.equal(rct.status, 201);
  assert.equal(crown.status, 201);

  /* --- 11. duplicate submission guards --- */
  const dup = await doctor.post(`${base}/findings`, { tooth_number: 16, condition: 'caries', surfaces: ['M', 'O'] });
  assert.equal(dup.status, 409, 'exact active duplicate must be rejected');
  const dupNoSurfaces = await doctor.post(`${base}/findings`, { tooth_number: 11, condition: 'crown' });
  assert.equal(dupNoSurfaces.status, 409);
  // same condition, different surfaces is allowed (MO caries + D caries)
  const otherSurface = await doctor.post(`${base}/findings`, { tooth_number: 16, condition: 'caries', surfaces: ['D'] });
  assert.equal(otherSurface.status, 201);

  /* --- 13 (server-side). clinical safety / contradictions --- */
  const missing = await doctor.post(`${base}/findings`, { tooth_number: 38, condition: 'missing', note: 'Agenesis' });
  assert.equal(missing.status, 201);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 38, condition: 'caries' })).status, 409);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 38, condition: 'extracted' })).status, 409);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 38, condition: 'healthy' })).status, 409);
  // implant may carry a crown but not caries
  const impl = await doctor.post(`${base}/findings`, { tooth_number: 46, condition: 'implant', note: 'Implant placed 2 years ago' });
  assert.equal(impl.status, 201);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 46, condition: 'caries' })).status, 409);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 46, condition: 'crown' })).status, 201);
  // healthy excludes pathology both ways
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 21, condition: 'healthy' })).status, 201);
  assert.equal((await doctor.post(`${base}/findings`, { tooth_number: 21, condition: 'caries' })).status, 409);

  /* --- 5. surface-level records on primary teeth too --- */
  const primary = await doctor.post(`${base}/findings`, { tooth_number: 85, condition: 'filled', surfaces: ['O'], note: 'Primary molar restoration' });
  assert.equal(primary.status, 201);
  assert.equal(primary.data.finding.dentition, 'primary');

  /* --- chart payload reflects everything --- */
  const chart = await doctor.get(base);
  assert.equal(chart.status, 200);
  assert.equal(chart.data.chart.persisted, true);
  const tooth16 = chart.data.findings.filter((f) => f.tooth_number === 16 && f.status === 'active');
  assert.equal(tooth16.length, 2, 'MO caries + D caries');

  /* --- tooth detail endpoint --- */
  const detail = await doctor.get(`${base}/teeth/16`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.tooth_number, 16);
  assert.equal(detail.data.findings.length, 2);
  assert.ok(detail.data.history.length >= 2);

  /* --- 6B. planned treatments never touch current findings --- */
  const plan = await doctor.post(`${base}/treatments`, {
    tooth_number: 16, procedure: 'filling', surfaces: ['M', 'O'], note: 'Composite filling',
  });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.treatment.status, 'planned');
  const planDup = await doctor.post(`${base}/treatments`, { tooth_number: 16, procedure: 'filling', surfaces: ['O', 'M'] });
  assert.equal(planDup.status, 409, 'duplicate planned treatment rejected');
  let after = await doctor.get(`${base}/teeth/16`);
  assert.equal(after.data.findings.filter((f) => f.condition === 'filled').length, 0, 'planning must not create findings');

  /* --- 6C. completing: explicit apply + resolve, audited --- */
  const done = await doctor.patch(`${base}/treatments/${plan.data.treatment.id}/status`, {
    status: 'completed',
    completion_note: 'Composite placed, occlusion checked',
    apply: { condition: 'filled', surfaces: ['M', 'O'], note: 'Post-op: composite restoration' },
    resolve: ['caries'],
  });
  assert.equal(done.status, 200);
  assert.equal(done.data.treatment.status, 'completed');
  assert.equal(done.data.treatment.completed_by_name, 'Dr. Lina Haddad');
  assert.ok(done.data.treatment.completed_at);
  assert.equal(done.data.applied_findings.length, 1);
  assert.equal(done.data.applied_findings[0].condition, 'filled');
  assert.equal(done.data.resolved_findings.length, 2, 'both active caries findings on 16 resolved');

  after = await doctor.get(`${base}/teeth/16`);
  const active = after.data.findings.filter((f) => f.status === 'active');
  assert.equal(active.filter((f) => f.condition === 'caries').length, 0);
  assert.equal(active.filter((f) => f.condition === 'filled').length, 1);
  // resolved findings are preserved, never deleted
  assert.equal(after.data.findings.filter((f) => f.status === 'resolved').length, 2);

  // completing twice fails cleanly
  assert.equal((await doctor.patch(`${base}/treatments/${plan.data.treatment.id}/status`, { status: 'completed' })).status, 400);
  // cancelling requires a reason
  const plan2 = await doctor.post(`${base}/treatments`, { tooth_number: 11, procedure: 'crown' });
  assert.equal(plan2.status, 201);
  assert.equal((await doctor.patch(`${base}/treatments/${plan2.data.treatment.id}/status`, { status: 'cancelled' })).status, 400);
  const cancel = await doctor.patch(`${base}/treatments/${plan2.data.treatment.id}/status`, { status: 'cancelled', reason: 'Patient deferred' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.treatment.status, 'cancelled');
  // reopening a completed treatment is a correction: requires reason, keeps applied findings
  assert.equal((await doctor.patch(`${base}/treatments/${plan.data.treatment.id}/status`, { status: 'planned' })).status, 400);
  const reopen = await doctor.patch(`${base}/treatments/${plan.data.treatment.id}/status`, { status: 'planned', reason: 'Documentation error: wrong tooth planned' });
  assert.equal(reopen.status, 200);
  after = await doctor.get(`${base}/teeth/16`);
  assert.equal(after.data.findings.filter((f) => f.status === 'active' && f.condition === 'filled').length, 1, 'reopening must not silently revert clinical findings');

  /* --- corrections require a reason and keep old values --- */
  const fid = crown.data.finding.id;
  assert.equal((await doctor.put(`${base}/findings/${fid}`, { condition: 'filled' })).status, 400, 'condition change without reason rejected');
  const corrected = await doctor.put(`${base}/findings/${fid}`, { condition: 'filled', reason: 'Was documented as crown; actually a large composite' });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.finding.condition, 'filled');
  assert.equal((await doctor.put(`${base}/findings/${fid}`, { condition: 'filled' })).status, 400, 'no-op update rejected');
  // resolved findings are immutable
  const resolvedId = after.data.findings.find((f) => f.status === 'resolved').id;
  assert.equal((await doctor.put(`${base}/findings/${resolvedId}`, { note: 'x' })).status, 409);

  /* --- 7. chronological history --- */
  const hist = await doctor.get(`${base}/history?tooth=16`);
  assert.equal(hist.status, 200);
  const types = hist.data.events.map((e) => e.event_type);
  assert.ok(types.includes('finding_created'));
  assert.ok(types.includes('treatment_planned'));
  assert.ok(types.includes('treatment_completed'));
  assert.ok(types.includes('finding_resolved'));
  // newest first
  const times = hist.data.events.map((e) => new Date(e.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const correctionEvent = hist.data.events.find((e) => e.event_type === 'correction');
  assert.ok(correctionEvent === undefined || correctionEvent.tooth_number === 16);
  const tooth11hist = await doctor.get(`${base}/history?tooth=11`);
  const corr = tooth11hist.data.events.find((e) => e.event_type === 'correction');
  assert.ok(corr, 'condition change must be recorded as a correction');
  assert.equal(corr.old_value.condition, 'crown');
  assert.equal(corr.new_value.condition, 'filled');
  assert.match(corr.reason, /composite/i);
  assert.equal(corr.user_name, 'Dr. Lina Haddad');
  // patient-level timeline includes all teeth
  const all = await doctor.get(`${base}/history`);
  assert.ok(all.data.events.length >= tooth11hist.data.events.length + hist.data.events.length - 2);

  /* --- dentition config (mixed) --- */
  const cfg = await doctor.put(`${base}/config`, { dentition: 'mixed' });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.chart.dentition, 'mixed');
  assert.equal((await doctor.put(`${base}/config`, { dentition: 'banana' })).status, 400);
  const cfgHist = await doctor.get(`${base}/history`);
  assert.ok(cfgHist.data.events.some((e) => e.event_type === 'chart_config' && e.new_value.dentition === 'mixed'));

  /* --- audit log recorded (owner-only view) --- */
  const auditRes = await owner.get('/api/audit?limit=100');
  assert.equal(auditRes.status, 200);
  const actions = auditRes.data.items.map((e) => e.action);
  assert.ok(actions.some((a) => a === 'dental.finding.create'), 'audit must contain dental.finding.create');
  assert.ok(actions.some((a) => a === 'dental.treatment.complete'), 'audit must contain dental.treatment.complete');
  const auditDenied = await (await login('reception@alamal.demo')).get('/api/audit?limit=10');
  assert.equal(auditDenied.status, 403);

  /* --- 12. persistence across sessions (simulates page refresh / re-login) --- */
  const before = await doctor.get(base);
  const fresh = await login('omar@alamal.demo'); // different user, new session
  const reload = await fresh.get(base);
  assert.equal(reload.status, 200);
  assert.equal(reload.data.findings.length, before.data.findings.length, 'fresh session must see identical server state');
  assert.equal(reload.data.treatments.length, before.data.treatments.length);
  const f16 = reload.data.findings.filter((f) => f.tooth_number === 16);
  assert.ok(f16.some((f) => f.condition === 'filled' && f.status === 'active'));
  assert.ok(f16.some((f) => f.condition === 'caries' && f.status === 'resolved'));
  assert.equal(reload.data.chart.dentition, 'mixed');
});

/* ---------------- links to visits/records validated ---------------- */

test('dental: appointment/record links must belong to the same patient', async () => {
  const owner = await login('owner@alamal.demo');
  const pid = await firstPatientId(owner);
  const base = `/api/patients/${pid}/dental`;
  const bad = await owner.post(`${base}/findings`, { tooth_number: 27, condition: 'caries', appointment_id: 999999 });
  assert.equal(bad.status, 400);
  const badRec = await owner.post(`${base}/treatments`, { tooth_number: 27, procedure: 'filling', record_id: 999999 });
  assert.equal(badRec.status, 400);
});

/* ---------------- 14. migration state ---------------- */

test('dental: migration applied once, demo data intact, runner idempotent', async () => {
  const versions = (await db.q('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
  assert.ok(versions.includes('001_init.sql'), 'consolidated PostgreSQL migration applied');
  const client = await db.getPool().connect();
  try {
    assert.deepEqual(await pendingMigrations(client), [], 'no pending migrations after boot');
  } finally {
    client.release();
  }
  // seeded demo data untouched by the migration run
  assert.ok(Number((await db.q1('SELECT COUNT(*) c FROM patients')).c) > 0);
  assert.ok(Number((await db.q1('SELECT COUNT(*) c FROM appointments')).c) > 0);
  const tables = (await db.q(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'dental_%'"
  )).map((r) => r.table_name);
  assert.deepEqual(tables.sort(), ['dental_charts', 'dental_findings', 'dental_history', 'dental_treatments']);
  // append-only history: routine flows never UPDATE/DELETE it
  const h = Number((await db.q1('SELECT COUNT(*) c FROM dental_history')).c);
  assert.ok(h >= 10, 'history rows accumulated from the flow above');
});
