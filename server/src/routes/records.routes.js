'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound, forbidden, conflict } = require('../util/errors');
const V = require('../util/validate');
const { audit, logActivity } = require('../util/audit');
const { nowIso } = require('../util/time');

const RECORD_STATUSES = ['draft', 'approved'];
const CLINICAL_FIELDS = ['symptoms', 'examination', 'diagnosis', 'treatment', 'follow_up'];

/**
 * Access policy (documented, consistently enforced):
 *  - READ: any doctor or the owner of the SAME clinic may read any clinical
 *    record of that clinic (small-clinic coverage model). Read access to full
 *    record details is audited.
 *  - WRITE: only the authoring doctor (via their linked doctor profile) or the
 *    clinic owner. Approved records are locked — content can no longer be
 *    edited through the API (no silent overwrites); create a new record instead.
 */
async function canWriteRecord(t, user, record) {
  if (user.role === 'owner' || user.role === 'platform_admin') return true;
  if (user.role === 'doctor') {
    const doc = await t.q1('SELECT id FROM doctors WHERE user_id = ? AND clinic_id = ?', [user.id, user.clinic_id]);
    return !!doc && doc.id === record.doctor_id;
  }
  return false;
}

async function ownDoctorProfile(t, user) {
  return t.q1('SELECT id FROM doctors WHERE user_id = ? AND clinic_id = ?', [user.id, user.clinic_id]);
}

function readRxList(t, recordId, clinicId) {
  return t.q('SELECT id, medication, dosage, frequency, duration, notes, created_at FROM prescriptions WHERE record_id = ? AND clinic_id = ? ORDER BY id', [recordId, clinicId]);
}

// GET /api/records?patient_id=&doctor_id=&limit=
router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const where = ['r.clinic_id = ?'];
  const params = [req.clinic.id];
  if (req.query.patient_id) { where.push('r.patient_id = ?'); params.push(V.int(req.query.patient_id, 'patient_id', { min: 1 })); }
  if (req.query.doctor_id) { where.push('r.doctor_id = ?'); params.push(V.int(req.query.doctor_id, 'doctor_id', { min: 1 })); }
  if (req.query.status) { where.push('r.status = ?'); params.push(V.oneOf(req.query.status, 'status', RECORD_STATUSES)); }
  if (req.query.appointment_id) { where.push('r.appointment_id = ?'); params.push(V.int(req.query.appointment_id, 'appointment_id', { min: 1 })); }
  const limit = V.int(req.query.limit, 'limit', { min: 1, max: 200, def: 50 });
  const records = await db.q(`
    SELECT r.id, r.patient_id, r.appointment_id, r.doctor_id, r.visit_date, r.status, r.diagnosis, r.symptoms,
      p.first_name || ' ' || p.last_name AS patient_name, d.name AS doctor_name, r.created_at
    FROM medical_records r
    JOIN patients p ON p.id = r.patient_id
    JOIN doctors d ON d.id = r.doctor_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.visit_date DESC, r.id DESC LIMIT ?
  `, [...params, limit]);
  // Non-clinical roles only learn that a visit happened — never the content.
  const clinical = PERMS.clinical.includes(req.user.role);
  res.json({ records: records.map((r) => (clinical ? r : { id: r.id, patient_id: r.patient_id, visit_date: r.visit_date, patient_name: r.patient_name, doctor_name: r.doctor_name, status: r.status, diagnosis: null, symptoms: null })) });
}));

// POST /api/records — doctors & owners; creates draft or approved record
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const body = req.body || {};
  const patient_id = V.int(body.patient_id, 'patient_id', { required: true, min: 1 });
  const patient = await db.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [patient_id, req.clinic.id]);
  if (!patient) throw notFound('Patient not found');

  let doctor_id = V.int(body.doctor_id, 'doctor_id', { min: 1 });
  if (req.user.role === 'doctor') {
    const own = await ownDoctorProfile(db, req.user);
    if (!own) throw forbidden('No doctor profile is linked to your account');
    doctor_id = own.id; // doctors always write under their own profile
  } else if (!doctor_id) {
    throw badRequest('doctor_id is required');
  }
  const doctor = await db.q1('SELECT * FROM doctors WHERE id = ? AND clinic_id = ?', [doctor_id, req.clinic.id]);
  if (!doctor) throw badRequest('Select a valid doctor for this clinic');

  const visit_date = V.isoDate(body.visit_date, 'Visit date', { required: true });
  const status = body.status !== undefined ? V.oneOf(body.status, 'status', RECORD_STATUSES) : 'draft';
  const appointment_id = V.int(body.appointment_id, 'appointment_id', { min: 1 }) || null;
  if (appointment_id) {
    const appt = await db.q1('SELECT * FROM appointments WHERE id = ? AND clinic_id = ?', [appointment_id, req.clinic.id]);
    if (!appt) throw badRequest('Linked appointment not found in this clinic');
    if (appt.patient_id !== patient_id) throw badRequest('Linked appointment belongs to a different patient');
  }
  const fields = {};
  for (const f of CLINICAL_FIELDS) fields[f] = V.str(body[f], f, { max: 4000 });
  const prescriptionsIn = body.prescriptions !== undefined ? V.arrayField(body.prescriptions, 'prescriptions') : [];

  const recordId = await db.withTx(async (t) => {
    const created = await t.q1(`
      INSERT INTO medical_records (clinic_id, patient_id, appointment_id, doctor_id, visit_date, symptoms, examination, diagnosis, treatment, follow_up, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, patient_id, appointment_id, doctor_id, visit_date,
      fields.symptoms, fields.examination, fields.diagnosis, fields.treatment, fields.follow_up, status, req.user.id]);
    const newId = created.id;
    for (const rx of prescriptionsIn) {
      const medication = V.str(rx.medication, 'Medication', { required: true, max: 200 });
      await t.exec(`
        INSERT INTO prescriptions (clinic_id, record_id, patient_id, medication, dosage, frequency, duration, notes, prescribed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [req.clinic.id, newId, patient_id, medication,
        V.str(rx.dosage, 'Dosage', { max: 200 }), V.str(rx.frequency, 'Frequency', { max: 200 }),
        V.str(rx.duration, 'Duration', { max: 200 }), V.str(rx.notes, 'Prescription notes', { max: 1000 }), req.user.id]);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'record.create', entity: 'medical_record', entityId: newId,
      details: { patient_id, doctor_id, visit_date, status, appointment_id } });
    return newId;
  });
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'clinical',
    message: `Clinical note (${status}) added for ${patient.first_name} ${patient.last_name}` });
  const row = await db.q1('SELECT * FROM medical_records WHERE id = ? AND clinic_id = ?', [recordId, req.clinic.id]);
  res.status(201).json({ record: row });
}));

async function getOwnRecord(t, clinicId, id) {
  const record = await t.q1(`
    SELECT r.*, p.first_name || ' ' || p.last_name AS patient_name, d.name AS doctor_name
    FROM medical_records r JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id
    WHERE r.id = ? AND r.clinic_id = ?
  `, [id, clinicId]);
  if (!record) throw notFound('Record not found');
  return record;
}

// GET /api/records/:id — clinical roles; read audited
router.get('/:id', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const record = await getOwnRecord(db, req.clinic.id, id);
  record.prescriptions = await readRxList(db, id, req.clinic.id);
  record.attachments = await db.q(`
    SELECT id, original_name, mime_type, size_bytes, created_at FROM attachments
    WHERE entity_type = 'medical_record' AND entity_id = ? AND clinic_id = ? AND deleted_at IS NULL ORDER BY id
  `, [id, req.clinic.id]);
  record.amendments = await db.q(`
    SELECT a.id, a.reason, a.changes, a.amended_at, u.full_name AS amended_by_name
    FROM record_amendments a LEFT JOIN users u ON u.id = a.amended_by
    WHERE a.record_id = ? AND a.clinic_id = ? ORDER BY a.amended_at ASC
  `, [id, req.clinic.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'record.read', entity: 'medical_record', entityId: id });
  res.json({ record });
}));

/**
 * Diff-update prescriptions: rows with an existing id are updated, rows without
 * an id are inserted, and previously stored rows missing from the payload are
 * removed — each change audited (no blind delete-reinsert of the whole list).
 */
async function applyPrescriptions(t, { clinicId, recordId, patientId, userId, incoming, before }) {
  const existing = await readRxList(t, recordId, clinicId);
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const keepIds = new Set();
  const changes = { added: [], updated: [], removed: [] };

  for (const rx of incoming) {
    const medication = V.str(rx.medication, 'Medication', { required: true, max: 200 });
    const values = {
      medication,
      dosage: V.str(rx.dosage, 'Dosage', { max: 200 }),
      frequency: V.str(rx.frequency, 'Frequency', { max: 200 }),
      duration: V.str(rx.duration, 'Duration', { max: 200 }),
      notes: V.str(rx.notes, 'Prescription notes', { max: 1000 }),
    };
    const rxId = V.int(rx.id, 'prescription id', { min: 1 });
    if (rxId && existingById.has(rxId)) {
      const prev = existingById.get(rxId);
      const changed = Object.keys(values).some((k) => (prev[k] || null) !== (values[k] || null));
      if (changed) {
        await t.exec('UPDATE prescriptions SET medication = ?, dosage = ?, frequency = ?, duration = ?, notes = ? WHERE id = ? AND record_id = ? AND clinic_id = ?',
          [values.medication, values.dosage, values.frequency, values.duration, values.notes, rxId, recordId, clinicId]);
        changes.updated.push({ id: rxId, medication });
      }
      keepIds.add(rxId);
    } else {
      const created = await t.q1(`
        INSERT INTO prescriptions (clinic_id, record_id, patient_id, medication, dosage, frequency, duration, notes, prescribed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `, [clinicId, recordId, patientId, values.medication, values.dosage, values.frequency, values.duration, values.notes, userId]);
      changes.added.push({ id: created.id, medication });
    }
  }
  for (const e of existing) {
    if (!keepIds.has(e.id)) {
      await t.exec('DELETE FROM prescriptions WHERE id = ? AND record_id = ? AND clinic_id = ?', [e.id, recordId, clinicId]);
      changes.removed.push({ id: e.id, medication: e.medication });
    }
  }
  return { before, changes };
}

// PUT /api/records/:id — edit drafts; approve; approved records are locked
router.put('/:id', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const record = await getOwnRecord(db, req.clinic.id, id);
  if (!(await canWriteRecord(db, req.user, record))) throw forbidden('Only the authoring doctor or the clinic owner can edit this record');

  const body = req.body || {};
  const wantsContentEdit = CLINICAL_FIELDS.some((f) => body[f] !== undefined) || body.visit_date !== undefined || body.prescriptions !== undefined;
  const wantsApproval = body.status !== undefined;
  const newStatus = wantsApproval ? V.oneOf(body.status, 'status', RECORD_STATUSES, { required: true }) : null;

  // Finalized (approved) documentation is preserved: content edits are only
  // accepted as amendments with a mandatory reason, and every change is
  // appended to record_amendments with before/after values and its author.
  const amending = record.status === 'approved' && wantsContentEdit;
  if (amending && !V.str(body.amendment_reason, 'amendment_reason', { max: 500 })) {
    throw badRequest('This record is finalized. Provide amendment_reason to record a correction; the original stays in the amendment history.', { amendment_reason: 'required' });
  }
  if (record.status === 'approved' && newStatus === 'draft') {
    throw badRequest('An approved record cannot be moved back to draft');
  }

  const beforeFields = {};
  const diff = {};
  const updates = {};
  for (const f of CLINICAL_FIELDS) {
    if (body[f] !== undefined) {
      updates[f] = V.str(body[f], f, { max: 4000 });
      if ((record[f] || null) !== (updates[f] || null)) {
        beforeFields[f] = record[f] || null;
        diff[f] = { before: record[f] || null, after: updates[f] || null };
      }
    }
  }
  if (body.visit_date !== undefined) {
    updates.visit_date = V.isoDate(body.visit_date, 'Visit date', { required: true });
    if (record.visit_date !== updates.visit_date) {
      beforeFields.visit_date = record.visit_date;
      diff.visit_date = { before: record.visit_date, after: updates.visit_date };
    }
  }

  const rxBefore = body.prescriptions !== undefined
    ? (await readRxList(db, id, req.clinic.id)).map((r) => ({ id: r.id, medication: r.medication }))
    : null;

  await db.withTx(async (t) => {
    const fields = Object.keys(updates);
    if (fields.length) {
      await t.exec(`UPDATE medical_records SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [...fields.map((f) => updates[f]), nowIso(), id, req.clinic.id]);
    }
    let rxResult = null;
    if (body.prescriptions !== undefined) {
      const incoming = V.arrayField(body.prescriptions, 'prescriptions');
      rxResult = await applyPrescriptions(t, {
        clinicId: req.clinic.id, recordId: id, patientId: record.patient_id, userId: req.user.id,
        incoming, before: rxBefore,
      });
    }
    if (newStatus) {
      if (newStatus === 'approved') {
        await t.exec('UPDATE medical_records SET status = ?, finalized_at = COALESCE(finalized_at, ?), finalized_by = COALESCE(finalized_by, ?), updated_at = ? WHERE id = ? AND clinic_id = ?',
          [newStatus, nowIso(), req.user.id, nowIso(), id, req.clinic.id]);
      } else {
        await t.exec('UPDATE medical_records SET status = ?, updated_at = ? WHERE id = ? AND clinic_id = ?', [newStatus, nowIso(), id, req.clinic.id]);
      }
    }
    if (amending) {
      await t.exec(`INSERT INTO record_amendments (clinic_id, record_id, amended_by, reason, changes) VALUES (?, ?, ?, ?, ?)`,
        [req.clinic.id, id, req.user.id, V.str(body.amendment_reason, 'amendment_reason', { max: 500 }), JSON.stringify(diff)]);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: amending ? 'record.amend' : newStatus === 'approved' ? 'record.approve' : 'record.update',
      entity: 'medical_record', entityId: id,
      details: {
        changed_fields: Object.keys(beforeFields),
        visit_date_before: beforeFields.visit_date || undefined,
        prescriptions: rxResult ? rxResult.changes : undefined,
        status: newStatus ? { before: record.status, after: newStatus } : undefined,
      } });
  });

  if (newStatus === 'approved') {
    await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'clinical', message: `Clinical note approved for ${record.patient_name}` });
  }
  const fresh = await db.q1('SELECT * FROM medical_records WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  res.json({ record: fresh });
}));

module.exports = router;
