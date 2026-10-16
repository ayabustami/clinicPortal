'use strict';
/**
 * Waiting list — patients who want an earlier slot than the ones available.
 * Roles: scheduling roles (owner/receptionist/doctor).
 */
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');
const { nowIso } = require('../util/time');

const SELECT = `
  SELECT w.*, p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone,
    d.name AS doctor_name, s.name AS service_name
  FROM waiting_list w
  JOIN patients p ON p.id = w.patient_id
  LEFT JOIN doctors d ON d.id = w.doctor_id
  LEFT JOIN services s ON s.id = w.service_id
`;

function serialize(r) {
  return {
    id: r.id, patient_id: r.patient_id, patient_name: r.patient_name, patient_phone: r.patient_phone,
    doctor_id: r.doctor_id, doctor_name: r.doctor_name, service_id: r.service_id, service_name: r.service_name,
    reason: r.reason, status: r.status, booked_appointment_id: r.booked_appointment_id,
    created_by: r.created_by, created_at: r.created_at, resolved_at: r.resolved_at,
  };
}

// GET /api/waiting?status=waiting
router.get('/', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const status = req.query.status ? V.oneOf(req.query.status, 'status', ['waiting', 'booked', 'cancelled']) : 'waiting';
  const rows = await db.q(`${SELECT} WHERE w.clinic_id = ? AND w.status = ? ORDER BY w.created_at DESC LIMIT 100`, [req.clinic.id, status]);
  res.json({ items: rows.map(serialize) });
}));

// POST /api/waiting
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const body = req.body || {};
  const patientId = V.int(body.patient_id, 'patient_id', { required: true, min: 1 });
  const patient = await db.q1('SELECT id FROM patients WHERE id = ? AND clinic_id = ? AND is_active = 1', [patientId, req.clinic.id]);
  if (!patient) throw badRequest('Select a valid patient for this clinic.');
  const doctorId = body.doctor_id ? V.int(body.doctor_id, 'doctor_id', { min: 1 }) : null;
  const serviceId = body.service_id ? V.int(body.service_id, 'service_id', { min: 1 }) : null;
  const reason = V.str(body.reason, 'reason', { max: 500 });
  const dup = await db.q1("SELECT id FROM waiting_list WHERE clinic_id = ? AND patient_id = ? AND status = 'waiting'", [req.clinic.id, patientId]);
  if (dup) throw badRequest('This patient is already on the waiting list');
  const created = await db.q1(`
    INSERT INTO waiting_list (clinic_id, patient_id, doctor_id, service_id, reason, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'waiting', ?) RETURNING *
  `, [req.clinic.id, patientId, doctorId, serviceId, reason, req.user.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'waiting.add', entity: 'waiting_list', entityId: created.id, details: { patient_id: patientId, reason } });
  res.status(201).json({ item: serialize(created) });
}));

// POST /api/waiting/:id/resolve — book (links appointment) or cancel
router.post('/:id/resolve', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true, min: 1 });
  const body = req.body || {};
  const status = V.oneOf(body.status, 'status', ['booked', 'cancelled'], { required: true });
  const row = await db.q1(`${SELECT} WHERE w.id = ? AND w.clinic_id = ?`, [id, req.clinic.id]);
  if (!row) throw notFound('Waiting list entry not found');
  if (row.status !== 'waiting') throw badRequest(`Entry is already ${row.status}`);
  let appointmentId = null;
  if (status === 'booked') {
    appointmentId = V.int(body.appointment_id, 'appointment_id', { required: true, min: 1 });
    const appt = await db.q1('SELECT id, patient_id FROM appointments WHERE id = ? AND clinic_id = ?', [appointmentId, req.clinic.id]);
    if (!appt) throw badRequest('Appointment not found in this clinic');
    if (appt.patient_id !== row.patient_id) throw badRequest('The appointment belongs to a different patient');
  }
  const updated = await db.q1(`
    UPDATE waiting_list SET status = ?, booked_appointment_id = ?, resolved_at = ? WHERE id = ? RETURNING *
  `, [status, appointmentId, nowIso(), id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: `waiting.${status}`, entity: 'waiting_list', entityId: id, details: { appointment_id: appointmentId } });
  res.json({ item: serialize(updated) });
}));

module.exports = router;
