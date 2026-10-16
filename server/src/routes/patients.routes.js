'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound } = require('../util/errors');
const V = require('../util/validate');
const { resolvePatientId } = require('../util/patient-ref');
const { audit, logActivity } = require('../util/audit');
const { nowIso, parseIso } = require('../util/time');
const { normalizeArabic } = require('../util/arabic');

const GENDERS = ['male', 'female', 'other'];
/** Roles allowed to see clinical intake flags (allergies / medical info). */
const CLINICAL_FLAG_ROLES = ['owner', 'doctor', 'receptionist', 'platform_admin'];

async function nextMrn(t, clinicId) {
  const row = await t.q1('SELECT mrn FROM patients WHERE clinic_id = ? ORDER BY id DESC LIMIT 1', [clinicId]);
  let n = 1000;
  if (row) {
    const m = /^P-(\d+)$/.exec(row.mrn);
    if (m) n = parseInt(m[1], 10);
  }
  return `P-${n + 1}`;
}

/**
 * Role-based patient serializer. Explicit field selection — never SELECT *.
 * Accountants (billing-only) never receive clinical intake flags.
 */
function serializePatient(row, role) {
  if (!row) return null;
  const base = {
    id: row.id,
    clinic_id: row.clinic_id,
    mrn: row.mrn,
    first_name: row.first_name,
    last_name: row.last_name,
    dob: row.dob,
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    address: row.address,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (CLINICAL_FLAG_ROLES.includes(role)) {
    base.allergies = row.allergies;
    base.medical_info = row.medical_info;
  }
  return base;
}

function readPatientBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.first_name !== undefined) out.first_name = V.str(body.first_name, 'First name', { required: !partial, max: 80 });
  if (!partial || body.last_name !== undefined) out.last_name = V.str(body.last_name, 'Last name', { required: !partial, max: 80 });
  if (body.dob !== undefined) out.dob = V.isoDate(body.dob, 'Date of birth');
  if (body.gender !== undefined) out.gender = V.oneOf(body.gender, 'Gender', GENDERS);
  if (body.phone !== undefined) out.phone = V.str(body.phone, 'Phone', { max: 40 });
  if (body.email !== undefined) out.email = V.email(body.email, 'Email');
  if (body.address !== undefined) out.address = V.str(body.address, 'Address', { max: 200 });
  if (body.allergies !== undefined) out.allergies = V.str(body.allergies, 'Allergies', { max: 2000 });
  if (body.medical_info !== undefined) out.medical_info = V.str(body.medical_info, 'Medical information', { max: 4000 });
  return out;
}

// GET /api/patients?search=&page=&limit=  (Arabic-normalized matching included)
router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const search = (req.query.search || '').trim();
  const page = V.int(req.query.page, 'page', { min: 1, def: 1 });
  const limit = V.int(req.query.limit, 'limit', { min: 1, max: 100, def: 20 });
  const includeInactive = req.query.include_inactive === '1';
  const where = ['p.clinic_id = ?'];
  const params = [req.clinic.id];
  if (!includeInactive) where.push('p.is_active = 1');
  if (search) {
    // Multi-word queries (e.g. a full name) must match token-wise: every token has to
    // hit one of the searchable columns, so "First Last" finds the patient.
    const tokens = search.split(/\s+/).filter(Boolean).slice(0, 8);
    const conds = [];
    for (const tok of tokens) {
      const like = `%${tok}%`;
      const norm = `%${normalizeArabic(tok)}%`;
      conds.push('(p.first_name LIKE ? OR p.last_name LIKE ? OR p.mrn LIKE ? OR p.phone LIKE ? OR p.first_name_norm LIKE ? OR p.last_name_norm LIKE ?)');
      params.push(like, like, like, like, norm, norm);
    }
    if (conds.length) where.push(`(${conds.join(' AND ')})`);
  }
  const total = Number((await db.q1(`SELECT COUNT(*) AS c FROM patients p WHERE ${where.join(' AND ')}`, params)).c);
  const rows = await db.q(`
    SELECT p.id, p.mrn, p.first_name, p.last_name, p.dob, p.gender, p.phone, p.email, p.is_active,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id) AS visits
    FROM patients p
    WHERE ${where.join(' AND ')}
    ORDER BY p.last_name, p.first_name
    LIMIT ? OFFSET ?
  `, [...params, limit, (page - 1) * limit]);
  const items = rows.map((r) => ({ ...r, is_active: !!r.is_active, visits: Number(r.visits) }));
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

// POST /api/patients
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.patient_registration), asyncH(async (req, res) => {
  const data = readPatientBody(req.body || {});
  if (data.dob && data.dob > nowIso().slice(0, 10)) throw badRequest('Date of birth cannot be in the future');
  const mrn = V.str((req.body || {}).mrn, 'Patient number', { max: 20 }) || await nextMrn(db, req.clinic.id);
  const exists = await db.q1('SELECT id FROM patients WHERE clinic_id = ? AND mrn = ?', [req.clinic.id, mrn]);
  if (exists) throw badRequest(`Patient number ${mrn} already exists in this clinic`);

  const id = await db.withTx(async (t) => {
    const created = await t.q1(`
      INSERT INTO patients (clinic_id, mrn, first_name, last_name, dob, gender, phone, email, address, allergies, medical_info, first_name_norm, last_name_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, mrn, data.first_name, data.last_name, data.dob, data.gender,
      data.phone, data.email, data.address, data.allergies, data.medical_info,
      normalizeArabic(data.first_name), normalizeArabic(data.last_name)]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'patient.create', entity: 'patient', entityId: created.id, details: { mrn } });
    await logActivity(t, { clinicId: req.clinic.id, userId: req.user.id, kind: 'patient', message: `Registered patient ${data.first_name} ${data.last_name} (${mrn})` });
    return created.id;
  });
  const row = await db.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  res.status(201).json({ patient: serializePatient(row, req.user.role) });
}));

async function getOwnPatient(t, clinicId, id) {
  const patient = await t.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [id, clinicId]);
  if (!patient) throw notFound('Patient not found');
  return patient;
}

// GET /api/patients/:id — profile with role-gated history sections
router.get('/:id', requireAuth, requireClinic, asyncH(async (req, res) => {
  const patient = await getOwnPatient(db, req.clinic.id, await resolvePatientId(db, req.clinic.id, req.params.id));

  const appointments = await db.q(`
    SELECT a.id, a.start_at, a.duration_min, a.status, d.name AS doctor_name, s.name AS service_name
    FROM appointments a JOIN doctors d ON d.id = a.doctor_id LEFT JOIN services s ON s.id = a.service_id
    WHERE a.patient_id = ? AND a.clinic_id = ? ORDER BY a.start_at DESC LIMIT 50
  `, [patient.id, req.clinic.id]);

  let records = [];
  if (PERMS.clinical.includes(req.user.role)) {
    records = await db.q(`
      SELECT r.id, r.visit_date, r.diagnosis, r.status, d.name AS doctor_name,
        (SELECT COUNT(*) FROM prescriptions x WHERE x.record_id = r.id) AS prescriptions
      FROM medical_records r JOIN doctors d ON d.id = r.doctor_id
      WHERE r.patient_id = ? AND r.clinic_id = ? ORDER BY r.visit_date DESC, r.id DESC LIMIT 50
    `, [patient.id, req.clinic.id]);
    records = records.map((r) => ({ ...r, prescriptions: Number(r.prescriptions) }));
  }
  let invoices = [];
  if (PERMS.financial.includes(req.user.role)) {
    invoices = await db.q(`
      SELECT id, invoice_no, issue_date, total_cents, status, currency FROM invoices
      WHERE patient_id = ? AND clinic_id = ? ORDER BY id DESC LIMIT 20
    `, [patient.id, req.clinic.id]);
  }
  res.json({ patient: serializePatient(patient, req.user.role), appointments, records, invoices });
}));

// GET /api/patients/:id/timeline — unified, role-filtered history
router.get('/:id/timeline', requireAuth, requireClinic, asyncH(async (req, res) => {
  const patient = await getOwnPatient(db, req.clinic.id, await resolvePatientId(db, req.clinic.id, req.params.id));
  const tz = req.clinic.timezone;
  const role = req.user.role;

  /* Filters: ?types=appointment,record,... & ?from=&to= (clinic-wall dates) & ?limit */
  const TYPES = ['appointment', 'record', 'prescription', 'invoice', 'payment', 'dental', 'plan', 'session'];
  const wantTypes = req.query.types
    ? new Set(String(req.query.types).split(',').map((x) => x.trim()).filter((x) => TYPES.includes(x)))
    : null;
  let fromUtc = null; let toUtc = null;
  if (req.query.from) fromUtc = parseIso(`${V.isoDate(req.query.from, 'from')}T00:00:00`);
  if (req.query.to) toUtc = parseIso(`${V.isoDate(req.query.to, 'to')}T23:59:59`);
  const limit = Math.min(500, Math.max(10, V.int(req.query.limit, 'limit', { def: 300 })));
  const inRange = (at) => (!fromUtc || at >= fromUtc.toISOString()) && (!toUtc || at <= toUtc.toISOString());

  const events = [];
  const push = (ev) => {
    if (wantTypes && !wantTypes.has(ev.type)) return;
    if (!ev.at || !inRange(ev.at)) return;
    events.push(ev);
  };

  /* appointments (bounded to the filter window when present) */
  const appts = await db.q(`
    SELECT a.id, a.start_at, a.status, a.duration_min, a.appointment_type, d.name AS doctor_name, s.name AS service_name
    FROM appointments a JOIN doctors d ON d.id = a.doctor_id LEFT JOIN services s ON s.id = a.service_id
    WHERE a.patient_id = ? AND a.clinic_id = ?
    ORDER BY a.start_at DESC LIMIT 400
  `, [patient.id, req.clinic.id]);
  for (const a of appts) {
    push({
      type: 'appointment', at: a.start_at, id: a.id, status: a.status, actor: a.doctor_name,
      title: `Visit — ${a.service_name || 'appointment'}`,
      detail: `${a.doctor_name} · ${a.duration_min} min · ${String(a.appointment_type || 'new_visit').replace('_', ' ')}`,
      link: `/appointments?patient_id=${patient.id}`,
    });
  }

  if (PERMS.clinical.includes(role)) {
    const recs = await db.q(`
      SELECT r.id, r.visit_date, r.status, r.diagnosis, d.name AS doctor_name, r.created_at
      FROM medical_records r JOIN doctors d ON d.id = r.doctor_id
      WHERE r.patient_id = ? AND r.clinic_id = ? ORDER BY r.created_at DESC LIMIT 200
    `, [patient.id, req.clinic.id]);
    // single aggregate for prescription + attachment counts (no N+1)
    const counts = recs.length ? await db.q(`
      SELECT x.record_id, COUNT(*) AS c, 'rx' AS kind FROM prescriptions x
        WHERE x.record_id = ANY(?::int[]) GROUP BY x.record_id
      UNION ALL
      SELECT at.entity_id, COUNT(*) AS c, 'file' AS kind FROM attachments at
        WHERE at.entity_type = 'medical_record' AND at.entity_id = ANY(?::int[]) AND at.deleted_at IS NULL GROUP BY at.entity_id
    `, [[recs.map((r) => r.id)], [recs.map((r) => r.id)]]) : [];
    const rxBy = {}; const fileBy = {};
    for (const c of counts) (c.kind === 'rx' ? rxBy : fileBy)[c.record_id] = Number(c.c);
    for (const r of recs) {
      push({
        type: 'record', at: r.created_at, id: r.id, status: r.status, actor: r.doctor_name,
        title: r.status === 'draft' ? 'Clinical note (draft)' : 'Clinical note',
        detail: `${r.doctor_name}${r.diagnosis ? ` · ${r.diagnosis}` : ''}${rxBy[r.id] ? ` · ${rxBy[r.id]} prescription(s)` : ''}${fileBy[r.id] ? ` · ${fileBy[r.id]} file(s)` : ''}`,
        visit_date: r.visit_date,
        link: `/records?patient_id=${patient.id}&record_id=${r.id}`,
      });
    }
    const rxs = recs.length ? await db.q(`
      SELECT x.id, x.medication, x.created_at, x.record_id, d.name AS doctor_name
      FROM prescriptions x JOIN medical_records mr ON mr.id = x.record_id JOIN doctors d ON d.id = mr.doctor_id
      WHERE x.record_id = ANY(?::int[]) AND x.clinic_id = ? ORDER BY x.created_at DESC LIMIT 200
    `, [[recs.map((r) => r.id)], req.clinic.id]) : [];
    for (const rx of rxs) {
      push({ type: 'prescription', at: rx.created_at, id: rx.id, record_id: rx.record_id, actor: rx.doctor_name, title: 'Prescription', detail: rx.medication, link: `/records?patient_id=${patient.id}&record_id=${rx.record_id}` });
    }
  }

  if (PERMS.financial.includes(role)) {
    const invs = await db.q(`
      SELECT i.id, i.invoice_no, i.issue_date, i.total_cents, i.status, i.created_at, u.full_name AS actor
      FROM invoices i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.patient_id = ? AND i.clinic_id = ? ORDER BY i.created_at DESC LIMIT 200
    `, [patient.id, req.clinic.id]);
    for (const i of invs) {
      push({ type: 'invoice', at: i.created_at, id: i.id, status: i.status, actor: i.actor, title: `Invoice ${i.invoice_no}`, detail: `${(i.total_cents / 100).toFixed(2)}`, cents: i.total_cents, link: `/invoices/${i.id}` });
    }
    const pays = invs.length ? await db.q(`
      SELECT pm.id, pm.amount_cents, pm.method, pm.paid_at, pm.type, pm.invoice_id, u.full_name AS actor
      FROM payments pm LEFT JOIN users u ON u.id = pm.received_by
      WHERE pm.invoice_id = ANY(?::int[]) ORDER BY pm.paid_at DESC LIMIT 300
    `, [[invs.map((i) => i.id)]]) : [];
    for (const pm of pays) {
      push({
        type: 'payment', at: pm.paid_at, id: pm.id, invoice_id: pm.invoice_id, actor: pm.actor,
        title: pm.type === 'payment' ? 'Payment' : pm.type === 'refund' ? 'Refund' : 'Adjustment',
        detail: `${(pm.amount_cents / 100).toFixed(2)} · ${String(pm.method || '').replace('_', ' ')}`,
        cents: pm.amount_cents, link: `/invoices/${pm.invoice_id}`,
      });
    }
  }

  if (PERMS.clinical.includes(role)) {
    const dh = await db.q(`
      SELECT h.id, h.tooth_number, h.event_type, h.reason, h.created_at, u.full_name AS actor
      FROM dental_history h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.patient_id = ? AND h.clinic_id = ?
      ORDER BY h.created_at DESC LIMIT 200
    `, [patient.id, req.clinic.id]);
    for (const h of dh) {
      push({
        type: 'dental', at: h.created_at, id: h.id, status: h.event_type, actor: h.actor,
        title: `Tooth ${h.tooth_number}: ${h.event_type.replace(/_/g, ' ')}`,
        detail: h.reason || '', link: `/patients/${patient.id}/dental?tooth=${h.tooth_number}`,
      });
    }
  }

  const plans = await db.q(`
    SELECT tp.id, tp.title, tp.status, tp.created_at, tp.approved_at, u.full_name AS actor, ap.full_name AS approver
    FROM treatment_plans tp LEFT JOIN users u ON u.id = tp.created_by LEFT JOIN users ap ON ap.id = tp.approved_by
    WHERE tp.patient_id = ? AND tp.clinic_id = ? ORDER BY tp.created_at DESC LIMIT 60
  `, [patient.id, req.clinic.id]);
  for (const pl of plans) {
    push({ type: 'plan', at: pl.created_at, id: pl.id, status: pl.status, actor: pl.actor, title: `Treatment plan: ${pl.title}`, detail: pl.status, link: `/patients/${patient.id}?tab=plans&plan=${pl.id}` });
    if (pl.approved_at) push({ type: 'plan', at: pl.approved_at, id: pl.id, status: 'approved', actor: pl.approver, title: `Treatment plan approved: ${pl.title}`, detail: pl.approver ? `by ${pl.approver}` : '', link: `/patients/${patient.id}?tab=plans&plan=${pl.id}` });
  }
  const sess = plans.length ? await db.q(`
    SELECT ts.id, ts.title, ts.status, ts.completed_at, ts.appointment_id, ts.plan_id, a.start_at AS appt_start, u.full_name AS actor
    FROM treatment_sessions ts LEFT JOIN appointments a ON a.id = ts.appointment_id LEFT JOIN users u ON u.id = ts.completed_by
    WHERE ts.plan_id = ANY(?::int[]) AND ts.status IN ('scheduled','completed') LIMIT 80
  `, [[plans.map((pl) => pl.id)]]) : [];
  for (const se of sess) {
    const at = se.status === 'completed' ? se.completed_at : se.appt_start;
    if (!at) continue;
    push({
      type: 'session', at, id: se.id, status: se.status, actor: se.actor,
      title: se.status === 'completed' ? `Session completed: ${se.title}` : `Session scheduled: ${se.title}`,
      detail: se.status === 'completed' && se.actor ? `by ${se.actor}` : '',
      link: `/patients/${patient.id}?tab=plans&plan=${se.plan_id}`,
    });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  res.json({ patient_id: patient.id, timezone: tz, events: events.slice(0, limit) });
}));

// PUT /api/patients/:id
router.put('/:id', requireAuth, requireClinic, requireRole(...PERMS.patient_registration), asyncH(async (req, res) => {
  const id = await resolvePatientId(db, req.clinic.id, req.params.id);
  await getOwnPatient(db, req.clinic.id, id);
  const data = readPatientBody(req.body || {}, { partial: true });
  if (data.dob && data.dob > nowIso().slice(0, 10)) throw badRequest('Date of birth cannot be in the future');
  if (req.body && req.body.is_active !== undefined) data.is_active = V.bool(req.body.is_active) ? 1 : 0;
  if (data.first_name !== undefined) data.first_name_norm = normalizeArabic(data.first_name);
  if (data.last_name !== undefined) data.last_name_norm = normalizeArabic(data.last_name);

  const fields = Object.keys(data);
  if (fields.length === 0) throw badRequest('No fields to update');
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  await db.exec(`UPDATE patients SET ${sets}, updated_at = ? WHERE id = ? AND clinic_id = ?`,
    [...fields.map((f) => data[f]), nowIso(), id, req.clinic.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'patient.update', entity: 'patient', entityId: id, details: { fields } });
  const row = await db.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  res.json({ patient: serializePatient(row, req.user.role) });
}));

// GET /api/patients/:id/records — clinical roles only; read access is audited
router.get('/:id/records', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const patient = await getOwnPatient(db, req.clinic.id, await resolvePatientId(db, req.clinic.id, req.params.id));
  const records = await db.q(`
    SELECT r.id, r.clinic_id, r.patient_id, r.appointment_id, r.doctor_id, r.visit_date, r.status,
      r.symptoms, r.examination, r.diagnosis, r.treatment, r.follow_up, r.created_at, r.updated_at,
      d.name AS doctor_name, u.full_name AS created_by_name
    FROM medical_records r JOIN doctors d ON d.id = r.doctor_id
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.patient_id = ? AND r.clinic_id = ? ORDER BY r.visit_date DESC, r.id DESC
  `, [patient.id, req.clinic.id]);
  for (const r of records) {
    r.prescriptions = await db.q('SELECT id, medication, dosage, frequency, duration, notes, created_at FROM prescriptions WHERE record_id = ? ORDER BY id', [r.id]);
  }
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'record.read', entity: 'patient', entityId: patient.id, details: { count: records.length } });
  res.json({ patient_id: patient.id, records });
}));

module.exports = router;
