'use strict';
/**
 * Waiting Room domain helpers — the same-day physical queue of the clinic.
 * All functions run inside a caller-provided transaction/client (`t`) so the
 * queue always moves in lockstep with appointment status changes.
 *
 * Important semantics:
 *  - An entry may *reference* an appointment (check-in sync, or a patient who
 *    arrives late after a recorded no-show) but never rewrites it. A no_show
 *    appointment keeps its history; the queue entry is a separate record.
 *  - At most one ACTIVE entry (waiting/called/in_treatment) per patient per
 *    clinic, enforced by a partial unique index and re-checked here.
 */
const ACTIVE = ['waiting', 'called', 'in_treatment'];

function findActive(t, clinicId, patientId) {
  return t.q1(
    `SELECT * FROM waiting_room WHERE clinic_id = ? AND patient_id = ? AND status IN ('waiting','called','in_treatment')`,
    [clinicId, patientId],
  );
}

function findByAppointment(t, clinicId, appointmentId) {
  return t.q1(
    `SELECT * FROM waiting_room WHERE clinic_id = ? AND appointment_id = ? AND status IN ('waiting','called','in_treatment')`,
    [clinicId, appointmentId],
  );
}

async function createEntry(t, { clinicId, branchId, patientId, doctorId, appointmentId, visitType, reason, userId, status = 'waiting' }) {
  const row = await t.q1(
    `INSERT INTO waiting_room
       (clinic_id, branch_id, patient_id, doctor_id, appointment_id, visit_type, reason, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [clinicId, branchId || null, patientId, doctorId, appointmentId || null, visitType || 'new_visit', reason || null, status, userId],
  );
  return row;
}

/** Apply a queue status with the matching timestamp. */
async function setStatus(t, entry, status) {
  const stamp = {
    called: 'called_at = COALESCE(called_at, now())',
    in_treatment: 'started_at = COALESCE(started_at, now()), called_at = COALESCE(called_at, now())',
    completed: 'ended_at = now(), started_at = COALESCE(started_at, now())',
    left: 'ended_at = now()',
  }[status] || null;
  const set = stamp ? `status = ?, ${stamp}, updated_at = now()` : 'status = ?, updated_at = now()';
  return t.q1(`UPDATE waiting_room SET ${set} WHERE id = ? RETURNING *`, [status, entry.id]);
}

/**
 * Keep the queue consistent with an appointment status change.
 *  checked_in  -> patient arrived: ensure an active queue entry (link it if
 *                 one already exists, never duplicate).
 *  in_progress -> the visit started: queue entry moves to in_treatment.
 *  completed   -> queue entry completes.
 *  cancelled   -> queue entry is marked left (patient will not be seen).
 *  no_show     -> untouched: the queue and the booking history stay separate.
 */
async function syncFromAppointment(t, clinicId, appt, newStatus, userId = null) {
  if (newStatus === 'checked_in') {
    const active = await findActive(t, clinicId, appt.patient_id);
    if (active) {
      return t.q1('UPDATE waiting_room SET appointment_id = COALESCE(appointment_id, ?), updated_at = now() WHERE id = ? RETURNING *',
        [appt.id, active.id]);
    }
    return createEntry(t, {
      clinicId,
      branchId: appt.branch_id,
      patientId: appt.patient_id,
      doctorId: appt.doctor_id,
      appointmentId: appt.id,
      visitType: appt.appointment_type,
      reason: null,
      userId,
    });
  }
  if (newStatus === 'in_progress' || newStatus === 'completed' || newStatus === 'cancelled') {
    const entry = (await findByAppointment(t, clinicId, appt.id))
      || (await findActive(t, clinicId, appt.patient_id));
    if (!entry) return null;
    const target = newStatus === 'in_progress' ? 'in_treatment' : newStatus === 'completed' ? 'completed' : 'left';
    if (entry.status === target) return entry;
    if (target === 'in_treatment' && entry.status === 'completed') return entry; // never reopen
    return setStatus(t, entry, target);
  }
  return null;
}

module.exports = { ACTIVE, findActive, findByAppointment, createEntry, setStatus, syncFromAppointment };
