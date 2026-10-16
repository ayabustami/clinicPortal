'use strict';
/**
 * Treatment-plan domain logic: plans, sessions and plan items.
 *
 * Clinical-integrity rules enforced here (server-side, transactional):
 *  - Creating/scheduling a plan or session NEVER touches the dental chart.
 *  - A plan item may only be marked completed when either (a) it has no tooth
 *    link and an authorized clinician confirms it, or (b) it references a
 *    dental_treatment that is already 'completed' for the same tooth — i.e.
 *    the chart workflow remains the single source of clinical truth.
 *  - Postponed/cancelled items never update the chart or plan completion.
 *  - Plan completion is derived from item completion, never from the
 *    appointment status alone.
 */
const { badRequest, notFound, forbidden } = require('../util/errors');
const { nowIso } = require('../util/time');
const { audit } = require('../util/audit');

const PLAN_STATUSES = ['draft', 'pending_approval', 'approved', 'in_progress', 'completed', 'cancelled'];
const SESSION_STATUSES = ['planned', 'scheduled', 'in_progress', 'completed', 'cancelled'];
const ITEM_STATUSES = ['proposed', 'approved', 'scheduled', 'completed', 'cancelled', 'postponed'];

const PLAN_SELECT = `
  SELECT tp.*, d.name AS responsible_doctor_name,
    p.first_name || ' ' || p.last_name AS patient_name
  FROM treatment_plans tp
  JOIN patients p ON p.id = tp.patient_id
  LEFT JOIN doctors d ON d.id = tp.responsible_doctor_id
`;
const ITEM_SELECT = `
  SELECT i.*, s.name AS service_name
  FROM treatment_plan_items i
  LEFT JOIN services s ON s.id = i.service_id
`;
const SESSION_SELECT = 'SELECT * FROM treatment_sessions';

function sumItems(items) {
  return items.reduce((a, i) => a + (i.status === 'cancelled' ? 0 : Number(i.price_cents || 0) * Number(i.quantity || 1)), 0);
}

function serializePlan(plan, sessions = [], items = []) {
  const active = items.filter((i) => i.status !== 'cancelled');
  const gross = sumItems(items);
  const completed = items.filter((i) => i.status === 'completed');
  return {
    id: plan.id,
    clinic_id: plan.clinic_id,
    patient_id: plan.patient_id,
    patient_name: plan.patient_name || null,
    appointment_id: plan.appointment_id || null,
    title: plan.title,
    status: plan.status,
    responsible_doctor_id: plan.responsible_doctor_id,
    responsible_doctor_name: plan.responsible_doctor_name || null,
    priority: plan.priority,
    discount_cents: plan.discount_cents,
    notes: plan.notes,
    revision_of: plan.revision_of,
    created_by: plan.created_by,
    approved_by: plan.approved_by,
    approved_at: plan.approved_at,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    estimated_gross_cents: gross,
    estimated_total_cents: Math.max(0, gross - plan.discount_cents),
    estimated_min: active.reduce((a, i) => a + i.duration_min * (i.quantity || 1), 0),
    progress: {
      completed_items: completed.length,
      total_items: items.length,
      percent: items.length ? Math.round((completed.length / items.length) * 100) : 0,
    },
    sessions: sessions.map((s) => serializeSession(s, items.filter((i) => i.session_id === s.id))),
    items: items.map(serializeItem),
  };
}

function serializeSession(s, items = []) {
  return {
    id: s.id,
    plan_id: s.plan_id,
    position: s.position,
    title: s.title,
    status: s.status,
    estimated_min: s.estimated_min,
    appointment_id: s.appointment_id,
    notes: s.notes,
    completed_at: s.completed_at,
    completed_by: s.completed_by,
    subtotal_cents: sumItems(items),
    item_count: items.length,
    completed_items: items.filter((i) => i.status === 'completed').length,
  };
}

function serializeItem(i) {
  return {
    id: i.id,
    plan_id: i.plan_id,
    session_id: i.session_id,
    service_id: i.service_id,
    service_name: i.service_name || null,
    tooth_number: i.tooth_number,
    surfaces: i.surfaces || '',
    procedure_label: i.procedure_label,
    duration_min: i.duration_min,
    price_cents: i.price_cents,
    quantity: i.quantity || 1,
    line_total_cents: Number(i.price_cents || 0) * Number(i.quantity || 1),
    priority: i.priority || 'routine',
    sequence: i.sequence,
    status: i.status,
    dental_treatment_id: i.dental_treatment_id,
    completed_at: i.completed_at,
    completed_by: i.completed_by,
  };
}

async function getOwnPlan(t, clinicId, planId) {
  const plan = await t.q1(`${PLAN_SELECT} WHERE tp.id = ? AND tp.clinic_id = ?`, [planId, clinicId]);
  if (!plan) throw notFound('Treatment plan not found');
  return plan;
}

async function fetchPlanFull(t, clinicId, planId) {
  const plan = await getOwnPlan(t, clinicId, planId);
  const sessions = await t.q(`${SESSION_SELECT} WHERE plan_id = ? ORDER BY position, id`, [planId]);
  const items = await t.q(`${ITEM_SELECT} WHERE plan_id = ? ORDER BY sequence, id`, [planId]);
  return { plan, sessions, items };
}

/** Validate an item payload against the clinic catalog and FDI tooth rules. */
function readItemInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.service_id !== undefined) out.service_id = body.service_id ? Number(body.service_id) : null;
  if (!partial || body.tooth_number !== undefined) {
    out.tooth_number = body.tooth_number ? Number(body.tooth_number) : null;
    if (out.tooth_number) {
      const q = Math.floor(out.tooth_number / 10);
      const p = out.tooth_number % 10;
      const ok = (q >= 1 && q <= 4 && p >= 1 && p <= 8) || (q >= 5 && q <= 8 && p >= 1 && p <= 5);
      if (!ok) throw badRequest('tooth_number must be a valid FDI tooth number');
    }
  }
  if (!partial || body.surfaces !== undefined) out.surfaces = String(body.surfaces || '');
  if (!partial || body.procedure_label !== undefined) {
    out.procedure_label = String(body.procedure_label || '').trim();
    if (!out.procedure_label) throw badRequest('procedure_label is required');
    if (out.procedure_label.length > 200) throw badRequest('procedure_label too long');
  }
  if (body.duration_min !== undefined) {
    out.duration_min = Number(body.duration_min);
    if (!Number.isInteger(out.duration_min) || out.duration_min < 5 || out.duration_min > 480) {
      throw badRequest('duration_min must be 5-480 minutes');
    }
  }
  if (body.price_cents !== undefined) {
    out.price_cents = Math.round(Number(body.price_cents));
    if (!Number.isInteger(out.price_cents) || out.price_cents < 0) throw badRequest('price_cents must be >= 0');
  }
  if (body.sequence !== undefined) out.sequence = Number(body.sequence) || 1;
  if (body.session_id !== undefined) out.session_id = body.session_id ? Number(body.session_id) : null;
  if (body.quantity !== undefined) {
    out.quantity = Number(body.quantity);
    if (!Number.isInteger(out.quantity) || out.quantity < 1 || out.quantity > 99) {
      throw badRequest('quantity must be a whole number between 1 and 99');
    }
  }
  if (body.priority !== undefined) {
    const allowed = ['urgent', 'high', 'routine', 'low'];
    out.priority = String(body.priority || '');
    if (!allowed.includes(out.priority)) {
      throw badRequest(`priority must be one of: ${allowed.join(', ')}`);
    }
  }
  return out;
}

/** Duplicate guard: same plan + service + tooth + surfaces + session = inconsistent double entry. */
async function assertNotDuplicateItem(t, { planId, sessionId, serviceId, tooth, surfaces, excludeItemId }) {
  const dup = await t.q1(`
    SELECT id FROM treatment_plan_items
    WHERE plan_id = ? AND status NOT IN ('cancelled')
      AND COALESCE(service_id, -1) = COALESCE(?, -1)
      AND COALESCE(tooth_number, -1) = COALESCE(?, -1)
      AND COALESCE(surfaces, '') = COALESCE(?, '')
      AND COALESCE(session_id, -1) = COALESCE(?, -1)
      AND (?::int IS NULL OR id <> ?::int)`,
    [planId, serviceId || null, tooth || null, surfaces || '', sessionId || null, excludeItemId || null, excludeItemId || null]);
  if (dup) throw badRequest('This exact procedure (service, tooth, surfaces, session) is already on the plan');
}

/**
 * Link a successfully created appointment to a treatment session.
 * Called INSIDE the appointment-create transaction so the booking and the
 * session state change commit (or roll back) together.
 */
async function linkSessionForAppointment(t, { clinicId, sessionId, patientId, appointmentId, userId }) {
  const sess = await t.q1(`${SESSION_SELECT} WHERE id = ? AND clinic_id = ?`, [sessionId, clinicId]);
  if (!sess) throw badRequest('Unknown treatment session');
  const plan = await getOwnPlan(t, clinicId, sess.plan_id);
  if (plan.patient_id !== patientId) throw badRequest('Session belongs to a different patient');
  if (!['approved', 'in_progress'].includes(plan.status)) {
    throw badRequest('Only sessions of an approved treatment plan can be scheduled');
  }
  if (!['planned', 'scheduled'].includes(sess.status)) {
    throw badRequest(`Session is ${sess.status} and cannot be scheduled again`);
  }
  const existing = await t.q1(
    `SELECT id FROM appointments WHERE treatment_session_id = ? AND clinic_id = ?
       AND (?::int IS NULL OR id <> ?::int) AND status NOT IN ('cancelled','no_show')`,
    [sessionId, clinicId, appointmentId, appointmentId]);
  if (existing) throw badRequest('This session already has an active appointment');
  await t.exec(`UPDATE treatment_sessions SET status = 'scheduled', appointment_id = ?, updated_at = ? WHERE id = ?`,
    [appointmentId, nowIso(), sess.id]);
  await t.exec(`UPDATE treatment_plan_items SET status = 'scheduled', updated_at = ? WHERE session_id = ? AND status IN ('proposed','approved')`,
    [nowIso(), sess.id]);
  if (plan.status === 'approved') {
    await t.exec(`UPDATE treatment_plans SET status = 'in_progress', updated_at = ? WHERE id = ?`, [nowIso(), plan.id]);
  }
  await audit(t, {
    clinicId, userId, action: 'plan.session.scheduled', entity: 'treatment_session', entityId: sess.id,
    details: { plan_id: plan.id, appointment_id: appointmentId },
  });
  return sess;
}

/**
 * Complete a session with explicit per-item outcomes.
 * performed: item ids documented as done (tooth items require a completed
 * dental_treatment link); postponed: item ids left for a future session.
 */
async function completeSession(t, { clinicId, sessionId, userId, performed = [], postponed = [], note }) {
  const sess = await t.q1(`${SESSION_SELECT} WHERE id = ? AND clinic_id = ?`, [sessionId, clinicId]);
  if (!sess) throw notFound('Treatment session not found');
  if (!['scheduled', 'in_progress', 'planned'].includes(sess.status)) {
    throw badRequest(`A ${sess.status} session cannot be completed`);
  }
  const plan = await getOwnPlan(t, clinicId, sess.plan_id);
  const items = await t.q(`${ITEM_SELECT} WHERE session_id = ? ORDER BY sequence, id`, [sess.id]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const overlap = performed.filter((id) => postponed.includes(id));
  if (overlap.length) throw badRequest('An item cannot be both performed and postponed');

  for (const id of performed) {
    const item = byId.get(Number(id));
    if (!item) throw badRequest('Performed items must belong to this session');
    if (item.status === 'completed') continue;
    if (item.tooth_number) {
      if (!item.dental_treatment_id) {
        throw badRequest(`Item "${item.procedure_label}" (tooth ${item.tooth_number}) must be recorded and completed in the dental chart before the session can close`);
      }
      const dt = await t.q1('SELECT * FROM dental_treatments WHERE id = ? AND clinic_id = ? AND patient_id = ?',
        [item.dental_treatment_id, clinicId, plan.patient_id]);
      if (!dt || dt.status !== 'completed') {
        throw badRequest(`Item "${item.procedure_label}" links to dental treatment #${item.dental_treatment_id} which is not completed — complete and confirm it in the dental chart first`);
      }
      if (dt.tooth_number !== item.tooth_number) {
        throw badRequest(`Dental treatment #${dt.id} is on tooth ${dt.tooth_number}, item expects ${item.tooth_number}`);
      }
    }
    await t.exec(`UPDATE treatment_plan_items SET status = 'completed', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?`,
      [nowIso(), userId, nowIso(), item.id]);
  }
  for (const id of postponed) {
    const item = byId.get(Number(id));
    if (!item) throw badRequest('Postponed items must belong to this session');
    if (item.status === 'completed') throw badRequest(`Item "${item.procedure_label}" is already completed`);
    await t.exec(`UPDATE treatment_plan_items SET status = 'postponed', updated_at = ? WHERE id = ?`, [nowIso(), item.id]);
  }

  await t.exec(`UPDATE treatment_sessions SET status = 'completed', completed_at = ?, completed_by = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`,
    [nowIso(), userId, note || null, nowIso(), sess.id]);

  // Plan progress derives from items, not from the appointment/session alone.
  const allItems = await t.q('SELECT status FROM treatment_plan_items WHERE plan_id = ?', [sess.plan_id]);
  const remaining = allItems.filter((i) => ['proposed', 'approved', 'scheduled', 'postponed'].includes(i.status));
  const anyCompleted = allItems.some((i) => i.status === 'completed');
  const newPlanStatus = remaining.length === 0 ? 'completed' : anyCompleted ? 'in_progress' : plan.status;
  if (newPlanStatus !== plan.status) {
    await t.exec(`UPDATE treatment_plans SET status = ?, updated_at = ? WHERE id = ?`, [newPlanStatus, nowIso(), plan.id]);
  }
  await audit(t, {
    clinicId, userId, action: 'plan.session.completed', entity: 'treatment_session', entityId: sess.id,
    details: { plan_id: plan.id, performed: performed.map(Number), postponed: postponed.map(Number), plan_status: newPlanStatus },
  });
  return fetchPlanFull(t, clinicId, sess.plan_id);
}

module.exports = {
  assertNotDuplicateItem,
  PLAN_STATUSES, SESSION_STATUSES, ITEM_STATUSES,
  PLAN_SELECT, ITEM_SELECT, SESSION_SELECT,
  serializePlan, serializeSession, serializeItem,
  getOwnPlan, fetchPlanFull, readItemInput,
  linkSessionForAppointment, completeSession,
  forbidden,
};
