'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound, forbidden } = require('../util/errors');
const V = require('../util/validate');
const { audit, logActivity } = require('../util/audit');
const { parseIso, nowIso, wallParts } = require('../util/time');
const { normalizeArabic } = require('../util/arabic');
const svc = require('../services/appointments');
const waitingRoom = require('../services/waitingRoom');
const plans = require('../services/plans');

const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];
// Stage K lifecycle: booking -> arrival -> clinical visit, one validated
// machine. Arrival is only recorded from a live booking (scheduled/confirmed);
// a no-show can never follow arrival or an started visit; a clinical visit can
// only complete from in_progress (or one-step from checked_in); completed and
// no_show are terminal; a cancelled booking may be restored (re-validated).
const STATUS_FLOW = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: ['scheduled', 'confirmed'],
  no_show: [],
};
const ARRIVAL_STATUSES = ['not_arrived', 'arrived', 'no_show'];
const VISIT_STATUSES = ['not_started', 'in_progress', 'completed'];
const BOOKING_SOURCES = ['reception', 'phone', 'online', 'referral', 'other'];
/** Projection helpers: arrival/visit columns are derived, never free-typed. */
const arrivalFor = (status, prev) => (status === 'cancelled' ? prev
  : status === 'no_show' ? 'no_show'
    : ['checked_in', 'in_progress', 'completed'].includes(status) ? 'arrived' : 'not_arrived');
const visitFor = (status, prev) => (status === 'completed' ? 'completed'
  : status === 'in_progress' ? 'in_progress'
    : status === 'cancelled' ? prev : 'not_started');
/** Statuses only clinical staff (owner/doctor) may set. */
const CLINICAL_STATUSES = ['completed', 'in_progress'];

function parseStartInput(body) {
  const raw = body.start_at;
  if (raw === undefined || raw === null || raw === '') throw badRequest('start_at is required');
  const date = parseIso(raw);
  if (!date) throw badRequest('start_at must be a valid ISO date-time');
  return date;
}

function readAppointmentBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.patient_id !== undefined) out.patient_id = V.int(body.patient_id, 'patient_id', { required: !partial, min: 1 });
  if (!partial || body.doctor_id !== undefined) out.doctor_id = V.int(body.doctor_id, 'doctor_id', { required: !partial, min: 1 });
  if (body.service_id !== undefined) out.service_id = V.int(body.service_id, 'service_id', { min: 1 }) || null;
  if (body.service_ids !== undefined) {
    const arr = V.arrayField(body.service_ids, 'service_ids');
    out.service_ids = arr.map((v, i) => V.int(v, `service_ids[${i}]`, { min: 1 }));
    // An empty array clears the booked services (service_id falls back to null).
    if (body.service_id === undefined) out.service_id = out.service_ids.length ? out.service_ids[0] : null;
  }
  if (body.branch_id !== undefined) out.branch_id = V.int(body.branch_id, 'branch_id', { min: 1 }) || null;
  // duration_min is required on create unless service_ids are given — then it
  // defaults to the sum of catalog durations (snapshot-driven booking).
  const durationRequired = !partial && !out.service_ids;
  if (durationRequired || body.duration_min !== undefined) {
    out.duration_min = V.int(body.duration_min, 'duration_min', { required: durationRequired, min: 5, max: 480 });
  }
  if (body.notes !== undefined) out.notes = V.str(body.notes, 'notes', { max: 2000 });
  if (body.appointment_type !== undefined) {
    out.appointment_type = V.oneOf(body.appointment_type, 'appointment_type',
      ['new_visit', 'follow_up', 'consultation', 'procedure', 'emergency'], { required: !partial }) || 'new_visit';
  }
  if (body.booking_source !== undefined) {
    out.booking_source = V.oneOf(body.booking_source, 'booking_source',
      ['reception', 'phone', 'online', 'referral', 'other']) || 'reception';
  }
  if (body.treatment_session_id !== undefined) {
    out.treatment_session_id = body.treatment_session_id ? V.int(body.treatment_session_id, 'treatment_session_id', { min: 1 }) : null;
  }
  return out;
}

/** The doctor-profile id linked to the signed-in user (null if none). */
async function ownDoctorProfileId(t, user) {
  if (user.role !== 'doctor') return null;
  const doc = await t.q1('SELECT id FROM doctors WHERE user_id = ? AND clinic_id = ?', [user.id, user.clinic_id]);
  return doc ? doc.id : null;
}

/**
 * Doctors may only modify (reschedule/status) appointments assigned to their own
 * profile. Owners and receptionists manage the whole clinic. Documented policy.
 */
async function assertCanManage(t, req, appointment) {
  if (req.user.role === 'doctor') {
    const myId = await ownDoctorProfileId(t, req.user);
    if (myId !== appointment.doctor_id) {
      throw forbidden('Doctors can only modify appointments assigned to them');
    }
  }
}

// GET /api/appointments?start=&end=&doctor_id=&statuses=&branch_id=&patient_id=&q=&page=&limit=
// `q` searches patient name (Arabic-normalized too) or phone digits.
// Without `page` the legacy shape is returned (all matches in range, capped);
// with `page` the response carries {appointments, page, pages, total}.
router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const qs = req.query;
  const where = ['a.clinic_id = ?'];
  const params = [req.clinic.id];

  const start = parseIso(qs.start);
  const end = parseIso(qs.end);
  if (start && end) {
    // range overlap in PostgreSQL: [start_at, start_at + duration) ∩ [start, end)
    where.push('a.start_at < ?::timestamptz');
    where.push('a.start_at + make_interval(mins => a.duration_min) > ?::timestamptz');
    params.push(end.toISOString(), start.toISOString());
  } else if (start) {
    where.push('a.start_at >= ?::timestamptz');
    params.push(start.toISOString());
  } else if (end) {
    where.push('a.start_at < ?::timestamptz');
    params.push(end.toISOString());
  }

  if (qs.doctor_id) { where.push('a.doctor_id = ?'); params.push(V.int(qs.doctor_id, 'doctor_id', { min: 1 })); }
  if (qs.branch_id) { where.push('a.branch_id = ?'); params.push(V.int(qs.branch_id, 'branch_id', { min: 1 })); }
  if (qs.patient_id) { where.push('a.patient_id = ?'); params.push(V.int(qs.patient_id, 'patient_id', { min: 1 })); }
  if (qs.statuses) {
    const list = String(qs.statuses).split(',').map((s) => s.trim()).filter(Boolean);
    const valid = list.filter((s) => STATUSES.includes(s));
    if (list.length && !valid.length) throw badRequest('Unknown status filter');
    if (valid.length) { where.push(`a.status IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
  }
  if (qs.arrival) {
    const list = String(qs.arrival).split(',').map((x) => x.trim()).filter(Boolean);
    const valid = list.filter((x) => ARRIVAL_STATUSES.includes(x));
    if (list.length && !valid.length) throw badRequest('Unknown arrival filter');
    if (valid.length) { where.push(`a.arrival_status IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
  }
  if (qs.source) {
    const list = String(qs.source).split(',').map((x) => x.trim()).filter(Boolean);
    const valid = list.filter((x) => BOOKING_SOURCES.includes(x));
    if (list.length && !valid.length) throw badRequest('Unknown booking source filter');
    if (valid.length) { where.push(`a.booking_source IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
  }
  if (qs.q) {
    const term = V.str(qs.q, 'q', { max: 120 }).trim();
    if (term) {
      const escLike = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = term.replace(/\D/g, '');
      where.push(`(p.first_name || ' ' || p.last_name LIKE ? ESCAPE '\\'
        OR p.first_name_norm || ' ' || p.last_name_norm LIKE ? ESCAPE '\\'
        OR replace(replace(p.phone, ' ', ''), '-', '') LIKE ? ESCAPE '\\')`);
      params.push(escLike(term), escLike(normalizeArabic(term)), escLike(digits || term));
    }
  }

  const whereSql = where.join(' AND ');
  const paged = qs.page !== undefined;
  const page = V.int(qs.page, 'page', { min: 1, def: 1 });
  const limit = V.int(qs.limit, 'limit', { min: 1, max: 500, def: paged ? 25 : 2000 });

  let total = null;
  if (paged) {
    total = Number((await db.q1(`SELECT COUNT(*) AS c FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE ${whereSql}`, params)).c);
  }

  // Whitelisted sort options for the list workspace. Default keeps the
  // historical chronological order the calendar and My Day rely on.
  const orderBySql = {
    time_asc: 'a.start_at ASC',
    time_desc: 'a.start_at DESC',
      patient: '(p.first_name || \' \' || p.last_name) COLLATE "C" ASC, a.start_at ASC',
    doctor: 'd.name COLLATE "C" ASC, a.start_at ASC',
  }[String(qs.sort || 'time_asc')];
  if (!orderBySql) throw badRequest('Invalid sort');

  const rows = await db.q(`
    SELECT a.*,
      p.first_name || ' ' || p.last_name AS patient_name,
      p.phone AS patient_phone,
      p.mrn AS patient_mrn,
      d.name AS doctor_name, d.color AS doctor_color,
      s.name AS service_name,
      b.name AS branch_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    LEFT JOIN branches b ON b.id = a.branch_id
    WHERE ${whereSql}
    ORDER BY ${orderBySql}
    LIMIT ? OFFSET ?
  `, [...params, limit, paged ? (page - 1) * limit : 0]);

  const svcMap = await svc.fetchServicesForAppointments(db, req.clinic.id, rows.map((r) => r.id));
  const appointments = rows.map((r) => ({ ...svc.serializeAppointment({ ...r, services: svcMap.get(r.id) || null }), doctor_color: r.doctor_color }));
  if (paged) {
    return res.json({ appointments, page, pages: Math.max(1, Math.ceil(total / limit)), total });
  }
  res.json({ appointments });
}));

// POST /api/appointments
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const body = req.body || {};
  const input = readAppointmentBody(body);
  input.startUtc = parseStartInput(body);
  const status = body.status !== undefined ? V.oneOf(body.status, 'status', ['scheduled', 'confirmed']) : 'scheduled';
  input.status = status;

  const id = await db.withTx(async (t) => {
    let serviceRows = null;
    if (input.service_ids) {
      serviceRows = input.service_ids.length ? await svc.resolveServices(t, req.clinic.id, input.service_ids) : [];
      // Booked duration defaults to the sum of catalog durations; an explicit
      // duration_min in the payload still wins (validated 5..480).
      if (body.duration_min === undefined && serviceRows.length) {
        input.duration_min = serviceRows.reduce((sum, r) => sum + Number(r.duration_min), 0);
      }
      input.service_id = serviceRows.length ? serviceRows[0].id : null;
    }
    await svc.validate(t, req.clinic, input, {});
    const created = await t.q1(`
      INSERT INTO appointments (clinic_id, branch_id, patient_id, doctor_id, service_id, status, start_at, duration_min, notes, appointment_type, treatment_session_id, created_by, booking_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, input.branch_id, input.patient_id, input.doctor_id, input.service_id,
      status, input.startUtc.toISOString(), input.duration_min, input.notes || null,
      input.appointment_type || 'new_visit', input.treatment_session_id || null, req.user.id,
      input.booking_source || 'reception']);
    if (serviceRows) {
      await svc.writeAppointmentServices(t, req.clinic.id, created.id, serviceRows);
    }
    if (input.treatment_session_id) {
      await plans.linkSessionForAppointment(t, {
        clinicId: req.clinic.id, sessionId: input.treatment_session_id,
        patientId: input.patient_id, appointmentId: created.id, userId: req.user.id,
      });
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'appointment.create', entity: 'appointment', entityId: created.id,
      details: { doctor_id: input.doctor_id, start_at: input.startUtc.toISOString(), duration_min: input.duration_min,
        appointment_type: input.appointment_type || 'new_visit', treatment_session_id: input.treatment_session_id || null } });
    return created.id;
  });
  const full = await svc.fetchFull(db, req.clinic.id, id);
  const wall = wallParts(input.startUtc, req.clinic.timezone);
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'appointment',
    message: `Booked ${full.patient_name} with ${full.doctor_name} at ${wall.time}` });
  res.status(201).json({ appointment: svc.serializeAppointment(full) });
}));

// GET /api/appointments/summary?date=ISO — REAL per-status/arrival counts for
// one clinic day (defaults to today in the clinic timezone). Powers the list
// workspace summary indicators; never fabricated, always queried.
router.get('/summary', requireAuth, requireClinic, asyncH(async (req, res) => {
  const day = parseIso(req.query.date) || new Date();
  const { dayBoundsUtc } = require('../util/time');
  const [from, to] = dayBoundsUtc(day, req.clinic.timezone);
  const rows = await db.q(`
    SELECT status, arrival_status, COUNT(*)::int AS c
    FROM appointments
    WHERE clinic_id = ? AND start_at >= ?::timestamptz AND start_at < ?::timestamptz
    GROUP BY status, arrival_status
  `, [req.clinic.id, from, to]);
  const by_status = {}; const by_arrival = {}; let total = 0;
  for (const r of rows) {
    by_status[r.status] = (by_status[r.status] || 0) + Number(r.c);
    by_arrival[r.arrival_status] = (by_arrival[r.arrival_status] || 0) + Number(r.c);
    total += Number(r.c);
  }
  res.json({ date: from.slice(0, 10), total, by_status, by_arrival });
}));

async function getOwnAppointment(t, clinicId, id) {
  const appt = await t.q1('SELECT * FROM appointments WHERE id = ? AND clinic_id = ?', [id, clinicId]);
  if (!appt) throw notFound('Appointment not found');
  return appt;
}

// GET /api/appointments/:id
router.get('/:id', requireAuth, requireClinic, asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  await getOwnAppointment(db, req.clinic.id, id);
  const full = await svc.fetchFull(db, req.clinic.id, id);
  res.json({ appointment: svc.serializeAppointment(full) });
}));

// GET /api/appointments/:id/history — reschedule/status/cancel history built
// from the audit trail (single source of truth; no duplicate event table).
router.get('/:id/history', requireAuth, requireClinic, asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  await getOwnAppointment(db, req.clinic.id, id);
  const rows = await db.q(`
    SELECT l.id, l.action, l.created_at, l.details, u.full_name AS actor_name
    FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.clinic_id = ? AND l.entity = 'appointment' AND l.entity_id = ? AND l.action LIKE 'appointment.%'
    ORDER BY l.created_at ASC, l.id ASC
  `, [req.clinic.id, id]);
  res.json({
    events: rows.map((r) => ({
      id: Number(r.id), action: r.action, at: r.created_at, actor: r.actor_name || null,
      details: r.details ? JSON.parse(r.details) : null,
    })),
  });
}));

/**
 * PUT /api/appointments/:id — edit / reschedule / resize.
 * Status changes are NOT accepted here; they must go through the dedicated
 * PATCH /:id/status endpoint so the transition policy is always enforced.
 */
router.put('/:id', requireAuth, requireClinic, requireRole(...PERMS.scheduling), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const existing = await getOwnAppointment(db, req.clinic.id, id);
  const body = req.body || {};

  if (body.status !== undefined) {
    throw badRequest(
      'Status cannot be changed through the update endpoint. Use PATCH /api/appointments/:id/status so the workflow rules are enforced.'
    );
  }
  if (['completed', 'cancelled'].includes(existing.status)) {
    throw badRequest(`A ${existing.status.replace('_', ' ')} appointment cannot be edited or rescheduled`);
  }
  await assertCanManage(db, req, existing);

  const input = readAppointmentBody(body, { partial: true });
  const startUtc = body.start_at !== undefined ? parseStartInput(body) : new Date(existing.start_at);
  let serviceRows = null;
  if (input.service_ids) {
    serviceRows = input.service_ids.length ? await svc.resolveServices(db, req.clinic.id, input.service_ids) : [];
    input.service_id = serviceRows.length ? serviceRows[0].id : null;
    if (body.duration_min === undefined && serviceRows.length) {
      input.duration_min = serviceRows.reduce((sum, r) => sum + Number(r.duration_min), 0);
    }
  }
  const duration = input.duration_min !== undefined ? input.duration_min : existing.duration_min;
  const candidate = {
    patient_id: input.patient_id !== undefined ? input.patient_id : existing.patient_id,
    doctor_id: input.doctor_id !== undefined ? input.doctor_id : existing.doctor_id,
    service_id: input.service_id !== undefined ? input.service_id : existing.service_id,
    branch_id: input.branch_id !== undefined ? input.branch_id : existing.branch_id,
    duration_min: duration,
    startUtc,
  };

  await db.withTx(async (t) => {
    await svc.validate(t, req.clinic, candidate, { excludeId: id });
    if (serviceRows) await svc.writeAppointmentServices(t, req.clinic.id, id, serviceRows);
    await t.exec(`
      UPDATE appointments
      SET patient_id = ?, doctor_id = ?, service_id = ?, branch_id = ?, start_at = ?, duration_min = ?, notes = ?,
          appointment_type = ?, updated_at = ?
      WHERE id = ? AND clinic_id = ?
    `, [candidate.patient_id, candidate.doctor_id, candidate.service_id, candidate.branch_id,
      startUtc.toISOString(), duration, input.notes !== undefined ? input.notes : existing.notes,
      input.appointment_type !== undefined ? input.appointment_type : (existing.appointment_type || 'new_visit'),
      nowIso(), id, req.clinic.id]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'appointment.update', entity: 'appointment', entityId: id,
      details: {
        start_at: { before: existing.start_at, after: startUtc.toISOString() },
        duration_min: { before: existing.duration_min, after: duration },
        doctor_id: { before: existing.doctor_id, after: candidate.doctor_id },
      } });
  });
  const full = await svc.fetchFull(db, req.clinic.id, id);
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'appointment',
    message: `Updated appointment for ${full.patient_name} (${full.doctor_name})` });
  res.json({ appointment: svc.serializeAppointment(full) });
}));

/**
 * PATCH /api/appointments/:id/status — the ONLY way to change status.
 * Enforces STATUS_FLOW, clinical role restrictions, and full re-validation
 * (conflicts, working hours, leave) when a cancelled appointment is restored.
 */
router.patch('/:id/status', requireAuth, requireClinic, asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const existing = await getOwnAppointment(db, req.clinic.id, id);
  const status = V.oneOf((req.body || {}).status, 'status', STATUSES, { required: true });
  const reason = (req.body || {}).reason !== undefined
    ? V.str(req.body.reason, 'reason', { max: 500 }) : null;

  // Everyone in the clinic can view; changing status requires a scheduling role.
  if (!PERMS.scheduling.includes(req.user.role) && req.user.role !== 'platform_admin') {
    throw forbidden();
  }
  if (!STATUS_FLOW[existing.status].includes(status)) {
    throw badRequest(`Cannot change an appointment from "${existing.status.replace('_', ' ')}" to "${status.replace('_', ' ')}"`);
  }
  if (status === 'no_show' && parseIso(existing.start_at) > new Date()) {
    // A no-show records that the patient failed to arrive for an appointment
    // whose time has come. Upcoming appointments must be cancelled instead,
    // so the status can never be set "just because" from an open page.
    throw badRequest('A no-show can only be recorded once the appointment time has passed; cancel upcoming appointments instead');
  }
  if (CLINICAL_STATUSES.includes(status) && !PERMS.clinical.includes(req.user.role)) {
    throw badRequest(`Only a doctor or the clinic owner can mark an appointment as "${status.replace('_', ' ')}"`);
  }
  await assertCanManage(db, req, existing);

  await db.withTx(async (t) => {
    if (status === 'scheduled' && existing.status === 'cancelled') {
      // Restoring: re-run every scheduling rule — the slot may now be taken,
      // outside working hours, or inside a leave period.
      await svc.validate(t, req.clinic, {
        patient_id: existing.patient_id,
        doctor_id: existing.doctor_id,
        service_id: existing.service_id,
        branch_id: existing.branch_id,
        duration_min: existing.duration_min,
        startUtc: new Date(existing.start_at),
      }, { excludeId: id });
    }
    await t.exec(`
      UPDATE appointments
      SET status = ?, arrival_status = ?, visit_status = ?,
          cancelled_reason = ?, cancelled_at = ?, updated_at = ?
      WHERE id = ? AND clinic_id = ?
    `, [status, arrivalFor(status, existing.arrival_status), visitFor(status, existing.visit_status),
      status === 'cancelled' ? reason : null, status === 'cancelled' ? nowIso() : null,
      nowIso(), id, req.clinic.id]);
    // Keep the same-day Waiting Room queue in lockstep: check-in adds the
    // patient to the queue, in_progress/completed/cancelled move or close the
    // entry. Runs in the same transaction; no_show is deliberately untouched.
    await waitingRoom.syncFromAppointment(t, req.clinic.id, existing, status, req.user.id);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: `appointment.status.${status}`, entity: 'appointment', entityId: id,
      details: { from: existing.status, to: status, reason: status === 'cancelled' ? reason : undefined } });
  });
  const full = await svc.fetchFull(db, req.clinic.id, id);
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'appointment',
    message: `Appointment ${status.replace('_', ' ')}: ${full.patient_name} with ${full.doctor_name}` });
  res.json({ appointment: svc.serializeAppointment(full) });
}));

module.exports = router;
