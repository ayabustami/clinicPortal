'use strict';
/**
 * Waiting Room — the same-day physical queue (who is in the clinic now).
 * Roles: scheduling roles (owner/receptionist/doctor). Doctors additionally
 * only manage entries assigned to their own doctor profile, mirroring the
 * appointment ownership rule. Branch isolation via clinic scoping + optional
 * branch filter. All mutations are audited.
 */
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound, forbidden, conflict } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');
const { wallToUtc, addMinutes, todayLocalDate, parseIso } = require('../util/time');
const wr = require('../services/waitingRoom');

const STATUSES = ['waiting', 'called', 'in_treatment', 'completed', 'left'];
const FLOW = {
  waiting: ['called', 'in_treatment', 'left'],
  called: ['waiting', 'in_treatment', 'left'],
  in_treatment: ['completed', 'left'],
  completed: [],
  left: [],
};
const VISIT_TYPES = ['new_visit', 'follow_up', 'consultation', 'procedure', 'emergency'];

const SELECT = `
  SELECT w.*, 
    p.first_name || ' ' || p.last_name AS patient_name, p.mrn AS patient_mrn, p.phone AS patient_phone,
    d.name AS doctor_name, d.color AS doctor_color,
    a.status AS appointment_status, a.start_at AS appointment_start
  FROM waiting_room w
  JOIN patients p ON p.id = w.patient_id
  JOIN doctors d ON d.id = w.doctor_id
  LEFT JOIN appointments a ON a.id = w.appointment_id
`;

function serialize(r) {
  return {
    id: r.id, clinic_id: r.clinic_id, branch_id: r.branch_id,
    patient_id: r.patient_id, patient_name: r.patient_name, patient_mrn: r.patient_mrn, patient_phone: r.patient_phone,
    doctor_id: r.doctor_id, doctor_name: r.doctor_name, doctor_color: r.doctor_color,
    appointment_id: r.appointment_id, appointment_status: r.appointment_status || null,
    appointment_start: r.appointment_start || null,
    visit_type: r.visit_type, reason: r.reason, status: r.status,
    arrived_at: r.arrived_at, called_at: r.called_at, started_at: r.started_at, ended_at: r.ended_at,
    created_by: r.created_by, created_at: r.created_at,
  };
}

/** Today's range in the clinic timezone (queue is a same-day view by default). */
function todayRange(clinic) {
  const day = todayLocalDate(clinic.timezone);
  const start = wallToUtc(`${day} 00:00`, clinic.timezone);
  return { start, end: addMinutes(start, 24 * 60) };
}

async function ownDoctorProfileId(t, user) {
  if (user.role !== 'doctor') return null;
  const doc = await t.q1('SELECT id FROM doctors WHERE user_id = ? AND clinic_id = ?', [user.id, user.clinic_id]);
  return doc ? doc.id : null;
}

// GET /api/waiting-room?statuses=waiting,called&doctor_id=&branch_id=&start=&end=
router.get('/', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const qs = req.query;
  const where = ['w.clinic_id = ?'];
  const params = [req.clinic.id];

  if (qs.statuses) {
    const list = String(qs.statuses).split(',').map((s) => s.trim()).filter(Boolean);
    const valid = list.filter((s) => STATUSES.includes(s));
    if (list.length && !valid.length) throw badRequest('Unknown waiting-room status filter');
    if (valid.length) { where.push(`w.status IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
  } else {
    where.push("w.status IN ('waiting','called','in_treatment')");
  }
  if (qs.doctor_id) { where.push('w.doctor_id = ?'); params.push(V.int(qs.doctor_id, 'doctor_id', { min: 1 })); }
  if (qs.branch_id) { where.push('w.branch_id = ?'); params.push(V.int(qs.branch_id, 'branch_id', { min: 1 })); }
  const { start: defStart, end: defEnd } = todayRange(req.clinic);
  const start = parseIso(qs.start) || defStart;
  const end = parseIso(qs.end) || defEnd;
  where.push('w.arrived_at >= ?::timestamptz AND w.arrived_at < ?::timestamptz');
  params.push(start.toISOString(), end.toISOString());

  const rows = await db.q(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY w.arrived_at ASC LIMIT 300`, params);
  res.json({ items: rows.map(serialize) });
}));

// POST /api/waiting-room — add a patient to the queue (walk-in, late arrival
// after a no-show, or manual queue entry). Never touches appointment records.
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const body = req.body || {};
  const patientId = V.int(body.patient_id, 'patient_id', { required: true, min: 1 });
  const doctorId = V.int(body.doctor_id, 'doctor_id', { required: true, min: 1 });
  const visitType = body.visit_type !== undefined
    ? V.oneOf(body.visit_type, 'visit_type', VISIT_TYPES, { required: true })
    : 'new_visit';
  const reason = body.reason !== undefined ? V.str(body.reason, 'reason', { max: 500 }) : null;
  const branchId = body.branch_id ? V.int(body.branch_id, 'branch_id', { min: 1 }) : null;
  const appointmentId = body.appointment_id ? V.int(body.appointment_id, 'appointment_id', { min: 1 }) : null;

  const created = await db.withTx(async (t) => {
    const patient = await t.q1('SELECT id FROM patients WHERE id = ? AND clinic_id = ? AND is_active = 1', [patientId, req.clinic.id]);
    if (!patient) throw badRequest('Select a valid patient for this clinic.');
    const doctor = await t.q1('SELECT id FROM doctors WHERE id = ? AND clinic_id = ?', [doctorId, req.clinic.id]);
    if (!doctor) throw badRequest('Select a dentist of this clinic.');
    if (branchId) {
      const branch = await t.q1('SELECT id FROM branches WHERE id = ? AND clinic_id = ?', [branchId, req.clinic.id]);
      if (!branch) throw badRequest('Select a branch of this clinic.');
    }
    let appt = null;
    if (appointmentId) {
      appt = await t.q1('SELECT id, status FROM appointments WHERE id = ? AND clinic_id = ?', [appointmentId, req.clinic.id]);
      if (!appt) throw badRequest('Select an appointment of this clinic.');
    }
    const dup = await wr.findActive(t, req.clinic.id, patientId);
    if (dup) throw conflict('This patient is already in the waiting room.');
    return wr.createEntry(t, {
      clinicId: req.clinic.id, branchId, patientId, doctorId, appointmentId,
      visitType, reason, userId: req.user.id,
    });
  });
  await audit(db, {
    clinicId: req.clinic.id, userId: req.user.id, action: 'waiting_room.add',
    entity: 'waiting_room', entityId: created.id,
    details: { patient_id: patientId, doctor_id: doctorId, appointment_id: appointmentId || null, visit_type: visitType },
  });
  const full = await db.q1(`${SELECT} WHERE w.id = ?`, [created.id]);
  res.status(201).json({ item: serialize(full) });
}));

// PATCH /api/waiting-room/:id/status — move the queue entry through
// waiting -> called -> in_treatment -> completed, or -> left from any active state.
router.patch('/:id/status', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const status = V.oneOf((req.body || {}).status, 'status', STATUSES, { required: true });

  const updated = await db.withTx(async (t) => {
    const entry = await t.q1('SELECT * FROM waiting_room WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
    if (!entry) throw notFound();
    if (req.user.role === 'doctor') {
      const myId = await ownDoctorProfileId(t, req.user);
      if (myId !== entry.doctor_id) throw forbidden('Doctors can only manage their own queue entries');
    }
    if (!FLOW[entry.status].includes(status)) {
      throw badRequest(`Cannot move a queue entry from "${entry.status.replace('_', ' ')}" to "${status.replace('_', ' ')}"`);
    }
    return wr.setStatus(t, entry, status);
  });
  await audit(db, {
    clinicId: req.clinic.id, userId: req.user.id, action: `waiting_room.status.${status}`,
    entity: 'waiting_room', entityId: updated.id,
    details: { patient_id: updated.patient_id, status },
  });
  const full = await db.q1(`${SELECT} WHERE w.id = ?`, [updated.id]);
  res.json({ item: serialize(full) });
}));

module.exports = router;
