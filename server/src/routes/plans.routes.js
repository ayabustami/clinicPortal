'use strict';
/**
 * Treatment plans, sessions and plan items.
 * Roles: any authenticated clinic member may read plans (scheduling needs it);
 * writes are clinical (owner/doctor); discounts are owner-only.
 */
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const { asyncH, badRequest } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');
const { nowIso } = require('../util/time');
const P = require('../services/plans');

const CLINICAL = ['owner', 'doctor'];

// GET /api/plans?patient_id=&status=
router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const params = [req.clinic.id];
  let sql = `${P.PLAN_SELECT} WHERE tp.clinic_id = ?`;
  if (req.query.patient_id) { params.push(V.int(req.query.patient_id, 'patient_id', { min: 1 })); sql += ' AND tp.patient_id = ?'; }
  if (req.query.status) { params.push(V.oneOf(req.query.status, 'status', P.PLAN_STATUSES)); sql += ' AND tp.status = ?'; }
  sql += ' ORDER BY tp.created_at DESC LIMIT 100';
  const rows = await db.q(sql, params);
  const out = [];
  for (const plan of rows) {
    const items = await db.q(`${P.ITEM_SELECT} WHERE plan_id = ? ORDER BY sequence, id`, [plan.id]);
    const sessions = await db.q(`${P.SESSION_SELECT} WHERE plan_id = ? ORDER BY position, id`, [plan.id]);
    out.push(P.serializePlan(plan, sessions, items));
  }
  res.json({ plans: out });
}));

// POST /api/plans — create plan (+ optional items/sessions) in one transaction
router.post('/', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const body = req.body || {};
  const patientId = V.int(body.patient_id, 'patient_id', { required: true, min: 1 });
  const title = V.str(body.title, 'title', { required: true, max: 200 });
  const doctorId = body.responsible_doctor_id ? V.int(body.responsible_doctor_id, 'responsible_doctor_id', { min: 1 }) : null;
  const priority = V.oneOf(body.priority, 'priority', ['urgent', 'high', 'routine', 'low']) || 'routine';
  const discount = body.discount_cents !== undefined ? Math.round(Number(body.discount_cents)) : 0;
  if (discount < 0) throw badRequest('discount_cents must be >= 0');
  if (discount > 0 && req.user.role !== 'owner') throw badRequest('Only the clinic owner may set plan discounts');
  const notes = V.str(body.notes, 'notes', { max: 2000 });
  const appointmentId = body.appointment_id ? V.int(body.appointment_id, 'appointment_id', { min: 1 }) : null;
  const itemsIn = Array.isArray(body.items) ? body.items : [];
  const sessionsIn = Array.isArray(body.sessions) ? body.sessions : [];

  const patient = await db.q1('SELECT id FROM patients WHERE id = ? AND clinic_id = ? AND is_active = 1', [patientId, req.clinic.id]);
  if (!patient) throw badRequest('Select a valid patient for this clinic.');
  if (doctorId) {
    const doc = await db.q1('SELECT id FROM doctors WHERE id = ? AND clinic_id = ? AND is_active = 1', [doctorId, req.clinic.id]);
    if (!doc) throw badRequest('Select an active doctor for this clinic.');
  }

  const result = await db.withTx(async (t) => {
    const plan = await t.q1(`
      INSERT INTO treatment_plans (clinic_id, patient_id, title, status, responsible_doctor_id, priority, discount_cents, notes, created_by, appointment_id)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, patientId, title, doctorId, priority, discount, notes, req.user.id, appointmentId]);

    const sessionIds = [];
    for (let i = 0; i < sessionsIn.length; i += 1) {
      const s = sessionsIn[i];
      const sid = await t.q1(`
        INSERT INTO treatment_sessions (clinic_id, plan_id, position, title, status, estimated_min, notes)
        VALUES (?, ?, ?, ?, 'planned', ?, ?) RETURNING id
      `, [req.clinic.id, plan.id, i + 1, V.str(s.title, `sessions[${i}].title`, { required: true, max: 200 }),
        V.int(s.estimated_min, `sessions[${i}].estimated_min`, { min: 0 }) || 0, V.str(s.notes, `sessions[${i}].notes`, { max: 2000 })]);
      sessionIds.push(sid.id);
    }

    for (let i = 0; i < itemsIn.length; i += 1) {
      const raw = itemsIn[i];
      const it = P.readItemInput(raw);
      let price = it.price_cents;
      if (price === undefined || price === null) price = 0;
      let sessionId = null;
      if (raw.session_index !== undefined && raw.session_index !== null) {
        const idx = Number(raw.session_index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= sessionIds.length) throw badRequest(`items[${i}].session_index out of range`);
        sessionId = sessionIds[idx];
      }
      if (it.service_id) {
        const svc = await t.q1('SELECT * FROM services WHERE id = ? AND clinic_id = ? AND is_active = 1', [it.service_id, req.clinic.id]);
        if (!svc) throw badRequest(`items[${i}]: select a valid service`);
        if (price === 0 && svc.price_cents) price = svc.price_cents;
        if (it.duration_min === undefined) it.duration_min = svc.duration_min || 30;
      }
      await P.assertNotDuplicateItem(t, {
        planId: plan.id, sessionId, serviceId: it.service_id, tooth: it.tooth_number, surfaces: it.surfaces,
      });
      await t.q1(`
        INSERT INTO treatment_plan_items (clinic_id, plan_id, session_id, service_id, tooth_number, surfaces, procedure_label, duration_min, price_cents, quantity, priority, sequence, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed') RETURNING id
      `, [req.clinic.id, plan.id, sessionId, it.service_id || null, it.tooth_number || null, it.surfaces || '',
        it.procedure_label, it.duration_min || 30, price, it.quantity || 1, it.priority || 'routine', i + 1]);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.create', entity: 'treatment_plan', entityId: plan.id, details: { patient_id: patientId, items: itemsIn.length, sessions: sessionsIn.length } });
    return P.fetchPlanFull(t, req.clinic.id, plan.id);
  });
  res.status(201).json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// GET /api/plans/:id
router.get('/:id', requireAuth, requireClinic, asyncH(async (req, res) => {
  const { plan, sessions, items } = await P.fetchPlanFull(db, req.clinic.id, V.int(req.params.id, 'id', { required: true, min: 1 }));
  res.json({ plan: P.serializePlan(plan, sessions, items) });
}));

// PUT /api/plans/:id — edit header fields (draft/pending only)
router.put('/:id', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const body = req.body || {};
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const result = await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (!['draft', 'pending_approval'].includes(plan.status)) throw badRequest(`A ${plan.status} plan cannot be edited — create a revision instead`);
    const title = body.title !== undefined ? V.str(body.title, 'title', { required: true, max: 200 }) : plan.title;
    const doctorId = body.responsible_doctor_id !== undefined ? (body.responsible_doctor_id ? V.int(body.responsible_doctor_id, 'responsible_doctor_id', { min: 1 }) : null) : plan.responsible_doctor_id;
    const priority = body.priority !== undefined ? V.oneOf(body.priority, 'priority', ['urgent', 'high', 'routine', 'low']) : plan.priority;
    let discount = plan.discount_cents;
    if (body.discount_cents !== undefined) {
      if (req.user.role !== 'owner') throw badRequest('Only the clinic owner may set plan discounts');
      discount = Math.round(Number(body.discount_cents));
      if (discount < 0) throw badRequest('discount_cents must be >= 0');
    }
    const notes = body.notes !== undefined ? V.str(body.notes, 'notes', { max: 2000 }) : plan.notes;
    await t.exec(`UPDATE treatment_plans SET title = ?, responsible_doctor_id = ?, priority = ?, discount_cents = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [title, doctorId, priority, discount, notes, nowIso(), planId]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.update', entity: 'treatment_plan', entityId: planId, details: { title } });
    return P.fetchPlanFull(t, req.clinic.id, planId);
  });
  res.json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// POST /api/plans/:id/items — add item
router.post('/:id/items', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const it = P.readItemInput(req.body || {});
  const result = await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (!['draft', 'pending_approval', 'approved', 'in_progress'].includes(plan.status)) throw badRequest(`Items cannot be added to a ${plan.status} plan`);
    let price = it.price_cents || 0;
    if (it.service_id) {
      const svc = await t.q1('SELECT * FROM services WHERE id = ? AND clinic_id = ? AND is_active = 1', [it.service_id, req.clinic.id]);
      if (!svc) throw badRequest('Select a valid service');
      if (!price && svc.price_cents) price = svc.price_cents;
      if (it.duration_min === undefined) it.duration_min = svc.duration_min || 30;
    }
    let sessionId = it.session_id || null;
    if (sessionId) {
      const sess = await t.q1(`${P.SESSION_SELECT} WHERE id = ? AND plan_id = ?`, [sessionId, planId]);
      if (!sess) throw badRequest('Session belongs to a different plan');
      if (sess.status === 'completed') throw badRequest('Cannot add items to a completed session');
    }
    await P.assertNotDuplicateItem(t, {
      planId, sessionId, serviceId: it.service_id, tooth: it.tooth_number, surfaces: it.surfaces,
    });
    const maxSeq = await t.q1('SELECT COALESCE(MAX(sequence),0)::int AS m FROM treatment_plan_items WHERE plan_id = ?', [planId]);
    await t.q1(`
      INSERT INTO treatment_plan_items (clinic_id, plan_id, session_id, service_id, tooth_number, surfaces, procedure_label, duration_min, price_cents, quantity, priority, sequence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, planId, sessionId, it.service_id || null, it.tooth_number || null, it.surfaces || '',
      it.procedure_label, it.duration_min || 30, price, it.quantity || 1, it.priority || 'routine', maxSeq.m + 1, plan.status === 'draft' || plan.status === 'pending_approval' ? 'proposed' : 'approved']);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.item.add', entity: 'treatment_plan', entityId: planId, details: { procedure: it.procedure_label, tooth: it.tooth_number || null } });
    return P.fetchPlanFull(t, req.clinic.id, planId);
  });
  res.status(201).json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// PUT /api/plans/:id/items/:itemId — move between sessions / reorder / update
router.put('/:id/items/:itemId', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const itemId = V.int(req.params.itemId, 'itemId', { required: true, min: 1 });
  const body = req.body || {};
  const result = await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    const item = await t.q1(`${P.ITEM_SELECT} WHERE i.id = ? AND i.plan_id = ?`, [itemId, planId]);
    if (!item) throw badRequest('Item belongs to a different plan');
    if (item.status === 'completed') throw badRequest('Completed items cannot be moved or edited');
    const patch = P.readItemInput(body, { partial: true });
    if (patch.session_id !== undefined && patch.session_id !== null) {
      const sess = await t.q1(`${P.SESSION_SELECT} WHERE id = ? AND plan_id = ?`, [patch.session_id, planId]);
      if (!sess) throw badRequest('Target session belongs to a different plan');
      if (sess.status === 'completed') throw badRequest('Cannot move items into a completed session');
      if (item.session_id && item.session_id !== patch.session_id) {
        const from = await t.q1(`${P.SESSION_SELECT} WHERE id = ?`, [item.session_id]);
        if (from && from.status === 'completed') throw badRequest('Cannot move items out of a completed session');
      }
    }
    const sets = [];
    const params = [];
    for (const [col, val] of Object.entries({ session_id: patch.session_id, service_id: patch.service_id, tooth_number: patch.tooth_number, surfaces: patch.surfaces, procedure_label: patch.procedure_label, duration_min: patch.duration_min, price_cents: patch.price_cents, sequence: patch.sequence, quantity: patch.quantity, priority: patch.priority })) {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val); }
    }
    if (!sets.length) throw badRequest('No updatable fields provided');
    params.push(nowIso(), itemId);
    await t.exec(`UPDATE treatment_plan_items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.item.update', entity: 'treatment_plan_item', entityId: itemId, details: { plan_id: planId, moved_to_session: patch.session_id ?? null } });
    return P.fetchPlanFull(t, req.clinic.id, planId);
  });
  res.json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// DELETE /api/plans/:id/items/:itemId
router.delete('/:id/items/:itemId', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const itemId = V.int(req.params.itemId, 'itemId', { required: true, min: 1 });
  await db.withTx(async (t) => {
    await P.getOwnPlan(t, req.clinic.id, planId);
    const item = await t.q1('SELECT * FROM treatment_plan_items WHERE id = ? AND plan_id = ? AND clinic_id = ?', [itemId, planId, req.clinic.id]);
    if (!item) throw badRequest('Item belongs to a different plan');
    if (item.status === 'completed') throw badRequest('Completed items are part of the clinical history and cannot be deleted');
    await t.exec('DELETE FROM treatment_plan_items WHERE id = ?', [itemId]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.item.delete', entity: 'treatment_plan_item', entityId: itemId, details: { plan_id: planId } });
  });
  res.json({ ok: true });
}));

// POST /api/plans/:id/sessions — add session (split into sessions)
router.post('/:id/sessions', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const body = req.body || {};
  const result = await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (['completed', 'cancelled'].includes(plan.status)) throw badRequest(`A ${plan.status} plan cannot gain sessions`);
    const maxPos = await t.q1('SELECT COALESCE(MAX(position),0)::int AS m FROM treatment_sessions WHERE plan_id = ?', [planId]);
    await t.q1(`
      INSERT INTO treatment_sessions (clinic_id, plan_id, position, title, status, estimated_min, notes)
      VALUES (?, ?, ?, ?, 'planned', ?, ?) RETURNING id
    `, [req.clinic.id, planId, maxPos.m + 1, V.str(body.title, 'title', { required: true, max: 200 }),
      V.int(body.estimated_min, 'estimated_min', { min: 0 }) || 0, V.str(body.notes, 'notes', { max: 2000 })]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.session.add', entity: 'treatment_plan', entityId: planId, details: { title: body.title } });
    return P.fetchPlanFull(t, req.clinic.id, planId);
  });
  res.status(201).json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// PUT /api/plans/:id/sessions/:sid — rename / reorder / re-estimate
router.put('/:id/sessions/:sid', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const sid = V.int(req.params.sid, 'sid', { required: true, min: 1 });
  const body = req.body || {};
  const result = await db.withTx(async (t) => {
    await P.getOwnPlan(t, req.clinic.id, planId);
    const sess = await t.q1(`${P.SESSION_SELECT} WHERE id = ? AND plan_id = ?`, [sid, planId]);
    if (!sess) throw badRequest('Session belongs to a different plan');
    if (sess.status === 'completed') throw badRequest('Completed sessions cannot be edited');
    const title = body.title !== undefined ? V.str(body.title, 'title', { required: true, max: 200 }) : sess.title;
    const position = body.position !== undefined ? V.int(body.position, 'position', { min: 1 }) : sess.position;
    const estimated = body.estimated_min !== undefined ? V.int(body.estimated_min, 'estimated_min', { min: 0 }) : sess.estimated_min;
    await t.exec(`UPDATE treatment_sessions SET title = ?, position = ?, estimated_min = ?, updated_at = ? WHERE id = ?`,
      [title, position, estimated, nowIso(), sid]);
    return P.fetchPlanFull(t, req.clinic.id, planId);
  });
  res.json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// POST /api/plans/:id/sessions/:sid/complete — partial completion supported
router.post('/:id/sessions/:sid/complete', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const sid = V.int(req.params.sid, 'sid', { required: true, min: 1 });
  const body = req.body || {};
  const performed = V.arrayField(body.performed, 'performed') || [];
  const postponed = V.arrayField(body.postponed, 'postponed') || [];
  const note = V.str(body.note, 'note', { max: 2000 });
  const result = await db.withTx(async (t) => P.completeSession(t, {
    clinicId: req.clinic.id, sessionId: sid, userId: req.user.id, performed, postponed, note,
  }));
  res.json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

// POST /api/plans/:id/submit | /approve | /cancel | /revision
router.post('/:id/submit', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (plan.status !== 'draft') throw badRequest(`Only draft plans can be submitted (plan is ${plan.status})`);
    const items = await t.q('SELECT id FROM treatment_plan_items WHERE plan_id = ?', [planId]);
    if (!items.length) throw badRequest('A plan needs at least one procedure before submission');
    await t.exec(`UPDATE treatment_plans SET status = 'pending_approval', updated_at = ? WHERE id = ?`, [nowIso(), planId]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.submit', entity: 'treatment_plan', entityId: planId, details: {} });
  });
  res.json({ ok: true });
}));

router.post('/:id/approve', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (!['draft', 'pending_approval'].includes(plan.status)) throw badRequest(`A ${plan.status} plan cannot be approved`);
    await t.exec(`UPDATE treatment_plans SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
      [req.user.id, nowIso(), nowIso(), planId]);
    await t.exec(`UPDATE treatment_plan_items SET status = 'approved', updated_at = ? WHERE plan_id = ? AND status = 'proposed'`, [nowIso(), planId]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.approve', entity: 'treatment_plan', entityId: planId, details: {} });
  });
  res.json({ ok: true });
}));

router.post('/:id/cancel', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const reason = V.str((req.body || {}).reason, 'reason', { required: true, max: 500 });
  await db.withTx(async (t) => {
    const plan = await P.getOwnPlan(t, req.clinic.id, planId);
    if (plan.status === 'completed') throw badRequest('A completed plan cannot be cancelled');
    await t.exec(`UPDATE treatment_plans SET status = 'cancelled', notes = COALESCE(notes,'') || ? , updated_at = ? WHERE id = ?`,
      [`\nCancelled: ${reason}`, nowIso(), planId]);
    await t.exec(`UPDATE treatment_plan_items SET status = 'cancelled', updated_at = ? WHERE plan_id = ? AND status NOT IN ('completed')`, [nowIso(), planId]);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.cancel', entity: 'treatment_plan', entityId: planId, details: { reason } });
  });
  res.json({ ok: true });
}));

// POST /api/plans/:id/revision — copy approved/completed plan into a new draft
router.post('/:id/revision', requireAuth, requireClinic, requireRole(...CLINICAL), asyncH(async (req, res) => {
  const planId = V.int(req.params.id, 'id', { required: true, min: 1 });
  const result = await db.withTx(async (t) => {
    const src = await P.fetchPlanFull(t, req.clinic.id, planId);
    const plan = await t.q1(`
      INSERT INTO treatment_plans (clinic_id, patient_id, title, status, responsible_doctor_id, priority, discount_cents, notes, revision_of, created_by)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?) RETURNING id
    `, [req.clinic.id, src.plan.patient_id, `${src.plan.title} (rev)`, src.plan.responsible_doctor_id,
      src.plan.priority, src.plan.discount_cents, src.plan.notes, planId, req.user.id]);
    const sessMap = new Map();
    for (const s of src.sessions) {
      const nid = await t.q1(`
        INSERT INTO treatment_sessions (clinic_id, plan_id, position, title, status, estimated_min, notes)
        VALUES (?, ?, ?, ?, 'planned', ?, ?) RETURNING id
      `, [req.clinic.id, plan.id, s.position, s.title, s.estimated_min, s.notes]);
      sessMap.set(s.id, nid.id);
    }
    for (const i of src.items.filter((x) => x.status !== 'completed')) {
      await t.q1(`
        INSERT INTO treatment_plan_items (clinic_id, plan_id, session_id, service_id, tooth_number, surfaces, procedure_label, duration_min, price_cents, sequence, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed') RETURNING id
      `, [req.clinic.id, plan.id, i.session_id ? sessMap.get(i.session_id) || null : null, i.service_id,
        i.tooth_number, i.surfaces, i.procedure_label, i.duration_min, i.price_cents, i.sequence]);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'plan.revision', entity: 'treatment_plan', entityId: plan.id, details: { revision_of: planId } });
    return P.fetchPlanFull(t, req.clinic.id, plan.id);
  });
  res.status(201).json({ plan: P.serializePlan(result.plan, result.sessions, result.items) });
}));

module.exports = router;
