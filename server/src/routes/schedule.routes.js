'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const { asyncH, badRequest, notFound } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');
const { parseIso } = require('../util/time');

/** Doctor leave / unavailable periods (rendered as background blocks in the calendar
 *  and enforced by the appointment validator). */

// GET /api/schedule/unavailability?start=&end=
router.get('/unavailability', requireAuth, requireClinic, asyncH(async (req, res) => {
  const where = ['u.clinic_id = ?'];
  const params = [req.clinic.id];
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);
  if (start) { where.push('u.end_at > ?::timestamptz'); params.push(start.toISOString()); }
  if (end) { where.push('u.start_at < ?::timestamptz'); params.push(end.toISOString()); }
  const items = await db.q(`
    SELECT u.id, u.doctor_id, u.start_at, u.end_at, u.reason, d.name AS doctor_name
    FROM doctor_unavailability u JOIN doctors d ON d.id = u.doctor_id
    WHERE ${where.join(' AND ')} ORDER BY u.start_at LIMIT 1000
  `, params);
  res.json({ unavailability: items });
}));

// POST /api/schedule/unavailability
router.post('/unavailability', requireAuth, requireClinic, requireRole('owner', 'receptionist'), asyncH(async (req, res) => {
  const body = req.body || {};
  const doctor_id = V.int(body.doctor_id, 'doctor_id', { required: true, min: 1 });
  const doctor = await db.q1('SELECT * FROM doctors WHERE id = ? AND clinic_id = ? AND is_active = 1', [doctor_id, req.clinic.id]);
  if (!doctor) throw badRequest('Select an active doctor for this clinic');
  const start = parseIso(body.start_at);
  const end = parseIso(body.end_at);
  if (!start || !end) throw badRequest('start_at and end_at must be valid ISO date-times');
  if (end <= start) throw badRequest('End must be after start');
  if (end.getTime() < Date.now()) throw badRequest('Cannot create a leave period entirely in the past');
  const reason = V.str(body.reason, 'Reason', { max: 500 });

  const created = await db.q1(`
    INSERT INTO doctor_unavailability (clinic_id, doctor_id, start_at, end_at, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `, [req.clinic.id, doctor_id, start.toISOString(), end.toISOString(), reason, req.user.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'unavailability.create', entity: 'doctor', entityId: doctor_id,
    details: { period_id: created.id, start_at: start.toISOString(), end_at: end.toISOString() } });
  res.status(201).json({ unavailability: created });
}));

// DELETE /api/schedule/unavailability/:id
router.delete('/unavailability/:id', requireAuth, requireClinic, requireRole('owner', 'receptionist'), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const row = await db.q1('SELECT * FROM doctor_unavailability WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  if (!row) throw notFound('Leave period not found');
  await db.exec('DELETE FROM doctor_unavailability WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'unavailability.delete', entity: 'doctor', entityId: row.doctor_id, details: { period_id: id } });
  res.json({ ok: true });
}));

module.exports = router;
