'use strict';
/**
 * Appointment domain logic: working-hours validation, double-booking
 * prevention and transactional create/update. All checks are server-side.
 *
 * Every function takes a db runner `t` (pool helpers from ../db or a
 * transaction handle) and is async — PostgreSQL access is asynchronous.
 */
const { badRequest, conflict, notFound } = require('../util/errors');
const { wallParts, addMinutes, nowIso } = require('../util/time');

const ACTIVE_STATUSES = ['scheduled', 'confirmed', 'checked_in', 'completed'];

/**
 * Find an overlapping appointment for the same doctor.
 * Overlap: start < otherEnd AND end > otherStart.
 * (SQLite's datetime(start_at,'+N minutes') becomes start_at + make_interval.)
 */
async function findConflict(t, { clinicId, doctorId, startUtc, endUtc, excludeId = null }) {
  const rows = await t.q(`
    SELECT a.*, p.first_name || ' ' || p.last_name AS patient_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    WHERE a.doctor_id = ? AND a.clinic_id = ?
      AND a.status IN ('scheduled','confirmed','checked_in','in_progress','completed')
      AND ?::timestamptz < a.start_at + make_interval(mins => a.duration_min)
      AND a.start_at < ?::timestamptz
      AND (?::int IS NULL OR a.id != ?::int)
    ORDER BY a.start_at ASC
  `, [doctorId, clinicId, startUtc, endUtc, excludeId, excludeId]);
  return rows.length ? rows[0] : null;
}

/** Find a leave/unavailable period overlapping the requested window. */
async function findUnavailability(t, { clinicId, doctorId, startUtc, endUtc }) {
  return t.q1(`
    SELECT u.*, d.name AS doctor_name
    FROM doctor_unavailability u JOIN doctors d ON d.id = u.doctor_id
    WHERE u.doctor_id = ? AND u.clinic_id = ?
      AND ?::timestamptz < u.end_at
      AND u.start_at < ?::timestamptz
    ORDER BY u.start_at LIMIT 1
  `, [doctorId, clinicId, startUtc, endUtc]);
}

/** Validate an appointment window against clinic working hours (clinic tz). */
function validateWorkingHours(clinic, startUtc, durationMin) {
  let hours = {};
  try { hours = JSON.parse(clinic.working_hours || '{}'); } catch { hours = {}; }
  const endUtc = addMinutes(startUtc, durationMin);
  const startWall = wallParts(startUtc, clinic.timezone);
  const endWall = wallParts(endUtc, clinic.timezone);

  const window = hours[String(startWall.weekday)];
  if (!window || !window.start || !window.end) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    throw badRequest(
      `${clinic.name} is closed on ${names[startWall.weekday]}. Choose a day within the clinic's working days.`
    );
  }
  if (startWall.time < window.start) {
    throw badRequest(`Appointments start at ${window.start} at the earliest. The clinic opens at ${window.start} on this day.`);
  }
  if (endWall.date !== startWall.date || endWall.time > window.end) {
    throw badRequest(
      `The appointment must end before ${window.end} (clinic closing time on this day). Reduce the duration or pick an earlier slot.`
    );
  }
  if (durationMin % 5 !== 0) {
    throw badRequest('Appointment duration must be a multiple of 5 minutes.');
  }
}

/** Ensure referenced patient/doctor/service/branch exist inside this clinic. */
async function resolveReferences(t, clinicId, { patient_id, doctor_id, service_id, branch_id }) {
  const patient = await t.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ? AND is_active = 1', [patient_id, clinicId]);
  if (!patient) throw badRequest('Select a valid patient for this clinic.');

  const doctor = await t.q1('SELECT * FROM doctors WHERE id = ? AND clinic_id = ? AND is_active = 1', [doctor_id, clinicId]);
  if (!doctor) throw badRequest('Select an active doctor for this clinic.');

  let service = null;
  if (service_id) {
    service = await t.q1('SELECT * FROM services WHERE id = ? AND clinic_id = ? AND is_active = 1', [service_id, clinicId]);
    if (!service) throw badRequest('Select a valid service for this clinic.');
  }

  let branch = null;
  if (branch_id) {
    branch = await t.q1('SELECT * FROM branches WHERE id = ? AND clinic_id = ? AND is_active = 1', [branch_id, clinicId]);
    if (!branch) throw badRequest('Select a valid branch for this clinic.');
  }
  return { patient, doctor, service, branch };
}

/**
 * Validate the full appointment payload. Throws ApiError on the first failure.
 * Takes a per-doctor transaction advisory lock first so two concurrent booking
 * requests for the same dentist serialize instead of racing past findConflict.
 */
async function validate(t, clinic, input, { excludeId = null } = {}) {
  const startUtc = input.startUtc;
  const duration = input.duration_min;
  if (!(startUtc instanceof Date) || Number.isNaN(startUtc.getTime())) {
    throw badRequest('A valid start time is required.');
  }
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
    throw badRequest('Duration must be between 5 and 480 minutes.');
  }
  // Serialize concurrent bookings per doctor inside this transaction.
  await t.q1('SELECT pg_advisory_xact_lock(?) AS locked', [input.doctor_id]);
  const refs = await resolveReferences(t, clinic.id, input);
  validateWorkingHours(clinic, startUtc, duration);
  const endUtc = addMinutes(startUtc, duration);
  const unavailable = await findUnavailability(t, {
    clinicId: clinic.id, doctorId: input.doctor_id,
    startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString(),
  });
  if (unavailable) {
    const wall = wallParts(new Date(unavailable.start_at), clinic.timezone);
    throw conflict(
      `${refs.doctor.name} is unavailable at that time (leave blocked from ${wall.date} ${wall.time}). Pick another time or doctor.`
    );
  }
  const existing = await findConflict(t, {
    clinicId: clinic.id, doctorId: input.doctor_id, startUtc: startUtc.toISOString(),
    endUtc: endUtc.toISOString(), excludeId,
  });
  if (existing) {
    const wall = wallParts(new Date(existing.start_at), clinic.timezone);
    throw conflict(
      `${refs.doctor.name} already has an appointment with ${existing.patient_name} ` +
      `at ${wall.time} (${existing.duration_min} min). Pick another time or doctor.`
    );
  }
  return refs;
}

function serializeAppointment(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    branch_id: row.branch_id,
    patient_id: row.patient_id,
    doctor_id: row.doctor_id,
    service_id: row.service_id,
    status: row.status,
    arrival_status: row.arrival_status || 'not_arrived',
    visit_status: row.visit_status || 'not_started',
    booking_source: row.booking_source || 'reception',
    cancelled_reason: row.cancelled_reason || null,
    cancelled_at: row.cancelled_at || null,
    start_at: row.start_at,
    duration_min: row.duration_min,
    notes: row.notes,
    appointment_type: row.appointment_type || 'new_visit',
    treatment_session_id: row.treatment_session_id || null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    patient_name: row.patient_name || null,
    patient_phone: row.patient_phone || null,
    patient_mrn: row.patient_mrn || null,
    doctor_name: row.doctor_name || null,
    service_name: row.service_name || null,
    branch_name: row.branch_name || null,
    services: row.services || null,
  };
}

/**
 * Multi-service booking helpers. An appointment books one or more catalog
 * services; each booked service snapshots its duration/price at booking time
 * (later catalog changes never rewrite history). appointments.service_id keeps
 * pointing at the first service for legacy consumers.
 */
async function resolveServices(t, clinicId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest('service_ids must be a non-empty array');
  if (ids.length > 6) throw badRequest('An appointment can book at most 6 services');
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw badRequest('Duplicate services in service_ids');
  const rows = await t.q(
    `SELECT * FROM services WHERE clinic_id = ? AND id IN (${unique.map(() => '?').join(',')})`,
    [clinicId, ...unique]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) throw badRequest(`Service #${id} was not found in this clinic`);
    if (!row.is_active) throw badRequest(`Service "${row.name}" is deactivated and can no longer be booked. Past appointments keep their booked services.`);
  }
  return unique.map((id) => byId.get(id));
}

async function writeAppointmentServices(t, clinicId, appointmentId, serviceRows) {
  await t.exec('DELETE FROM appointment_services WHERE appointment_id = ? AND clinic_id = ?', [appointmentId, clinicId]);
  let seq = 1;
  for (const svcRow of serviceRows) {
    await t.exec(`
      INSERT INTO appointment_services (clinic_id, appointment_id, service_id, sequence, duration_min, price_cents)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (appointment_id, service_id) DO NOTHING
    `, [clinicId, appointmentId, svcRow.id, seq++, Number(svcRow.duration_min), Number(svcRow.price_cents)]);
  }
}

/** Map appointmentId -> booked services (snapshots + current catalog name). */
async function fetchServicesForAppointments(t, clinicId, apptIds) {
  const out = new Map();
  if (!apptIds.length) return out;
  const rows = await t.q(`
    SELECT asv.appointment_id, asv.service_id, asv.sequence, asv.duration_min, asv.price_cents, s.name
    FROM appointment_services asv JOIN services s ON s.id = asv.service_id
    WHERE asv.clinic_id = ? AND asv.appointment_id IN (${apptIds.map(() => '?').join(',')})
    ORDER BY asv.appointment_id, asv.sequence
  `, [clinicId, ...apptIds]);
  for (const r of rows) {
    if (!out.has(r.appointment_id)) out.set(r.appointment_id, []);
    out.get(r.appointment_id).push({
      service_id: r.service_id, name: r.name, sequence: r.sequence,
      duration_min: Number(r.duration_min), price_cents: Number(r.price_cents),
    });
  }
  return out;
}

/** Full appointment row with joined names. */
async function fetchFull(t, clinicId, id) {
  const row = await t.q1(`
    SELECT a.*,
      p.first_name || ' ' || p.last_name AS patient_name,
      p.phone AS patient_phone,
      d.name AS doctor_name,
      s.name AS service_name,
      b.name AS branch_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    LEFT JOIN branches b ON b.id = a.branch_id
    WHERE a.id = ? AND a.clinic_id = ?
  `, [id, clinicId]);
  if (!row) return null;
  const map = await fetchServicesForAppointments(t, clinicId, [id]);
  row.services = map.get(id) || null;
  return row;
}

module.exports = {
  ACTIVE_STATUSES, findConflict, findUnavailability, validateWorkingHours, validate,
  resolveReferences, serializeAppointment, fetchFull, nowIso,
  resolveServices, writeAppointmentServices, fetchServicesForAppointments,
};
