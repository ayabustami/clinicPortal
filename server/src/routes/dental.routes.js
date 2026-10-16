'use strict';
/**
 * Dental chart (odontogram) API — mounted at /api/patients/:patientId/dental.
 *
 * Authorization (documented, consistently enforced):
 *  - Every route: authenticated user of an ACTIVE clinic, clinical roles only
 *    (PERMS.clinical = owner, doctor). platform_admin has no clinic and is
 *    rejected by requireClinic — administrative access never implies access
 *    to patient medical details. Receptionist/accountant get 403: no clinical
 *    data exposure.
 *  - Tenant isolation: the patient must belong to the caller's clinic;
 *    unknown and cross-clinic ids both return the same 404 (no enumeration).
 *  - Every write is transactional, validated server-side, appended to
 *    dental_history (old/new values + author) and recorded in audit_logs.
 */
const router = require('express').Router({ mergeParams: true });
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound, conflict } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');
const { nowIso } = require('../util/time');
const { resolvePatientId } = require('../util/patient-ref');
const D = require('../services/dental');

router.use(requireAuth, requireClinic, requireRole(...PERMS.clinical));

/* ---------------- serializers ---------------- */

const surfacesOut = (s) => (s ? s.split(',') : []);

function serializeFinding(f) {
  return {
    id: f.id, tooth_number: f.tooth_number, dentition: f.dentition,
    condition: f.condition, surfaces: surfacesOut(f.surfaces), status: f.status,
    note: f.note, appointment_id: f.appointment_id, record_id: f.record_id,
    created_by: f.created_by, created_by_name: f.created_by_name || null,
    updated_by_name: f.updated_by_name || null,
    created_at: f.created_at, updated_at: f.updated_at,
  };
}

function serializeTreatment(t) {
  return {
    id: t.id, tooth_number: t.tooth_number, dentition: t.dentition,
    procedure: t.procedure, surfaces: surfacesOut(t.surfaces), status: t.status,
    note: t.note, completion_note: t.completion_note,
    appointment_id: t.appointment_id, record_id: t.record_id,
    planned_by: t.planned_by, planned_by_name: t.planned_by_name || null, planned_at: t.planned_at,
    completed_by_name: t.completed_by_name || null, completed_at: t.completed_at,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

function serializeHistory(h) {
  let oldValue = null; let newValue = null;
  try { oldValue = h.old_value ? JSON.parse(h.old_value) : null; } catch { /* keep null */ }
  try { newValue = h.new_value ? JSON.parse(h.new_value) : null; } catch { /* keep null */ }
  return {
    id: h.id, tooth_number: h.tooth_number, dentition: h.dentition,
    event_type: h.event_type, entity: h.entity, entity_id: h.entity_id,
    old_value: oldValue, new_value: newValue, reason: h.reason, note: h.note,
    appointment_id: h.appointment_id, record_id: h.record_id,
    user_id: h.user_id, user_name: h.user_name || null, created_at: h.created_at,
  };
}

const FINDING_SELECT = `SELECT f.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
  FROM dental_findings f
  LEFT JOIN users cu ON cu.id = f.created_by
  LEFT JOIN users uu ON uu.id = f.updated_by`;

const TREATMENT_SELECT = `SELECT t.*, pu.full_name AS planned_by_name, cu.full_name AS completed_by_name
  FROM dental_treatments t
  LEFT JOIN users pu ON pu.id = t.planned_by
  LEFT JOIN users cu ON cu.id = t.completed_by`;

const HISTORY_SELECT = `SELECT h.*, u.full_name AS user_name
  FROM dental_history h LEFT JOIN users u ON u.id = h.user_id`;

/** Load patient (tenant-checked) + ensure/derive the chart configuration. */
async function loadContext(t, req, { persistChart = false } = {}) {
  const patientId = await resolvePatientId(db, req.clinic.id, req.params.patientId);
  const patient = await D.getOwnPatient(t, req.clinic.id, patientId);
  if (persistChart) {
    const { chart } = await D.ensureChart(t, { clinicId: req.clinic.id, patient, userId: req.user.id });
    return { patient, chart };
  }
  let chart = await t.q1('SELECT * FROM dental_charts WHERE clinic_id = ? AND patient_id = ?', [req.clinic.id, patient.id]);
  if (!chart) {
    const suggested = D.suggestDentition(patient.dob);
    chart = { id: null, dentition: suggested || 'permanent', dentition_suggested: suggested, persisted: false };
  }
  return { patient, chart };
}

async function getOwnFinding(t, clinicId, patientId, id) {
  const row = await t.q1(`${FINDING_SELECT} WHERE f.id = ? AND f.clinic_id = ? AND f.patient_id = ?`, [id, clinicId, patientId]);
  if (!row) throw notFound('Finding not found');
  return row;
}

async function getOwnTreatment(t, clinicId, patientId, id) {
  const row = await t.q1(`${TREATMENT_SELECT} WHERE t.id = ? AND t.clinic_id = ? AND t.patient_id = ?`, [id, clinicId, patientId]);
  if (!row) throw notFound('Treatment not found');
  return row;
}

/* ---------------- routes ---------------- */

// GET /api/patients/:patientId/dental — full chart payload
router.get('/', asyncH(async (req, res) => {
  const { patient, chart } = await loadContext(db, req);
  const findings = await db.q(`${FINDING_SELECT} WHERE f.clinic_id = ? AND f.patient_id = ? ORDER BY f.tooth_number, f.id`, [req.clinic.id, patient.id]);
  const treatments = await db.q(`${TREATMENT_SELECT} WHERE t.clinic_id = ? AND t.patient_id = ? ORDER BY t.tooth_number, t.id`, [req.clinic.id, patient.id]);
  res.json({
    chart: {
      id: chart.id, dentition: chart.dentition,
      dentition_suggested: chart.dentition_suggested ?? null,
      persisted: chart.persisted !== false, updated_at: chart.updated_at || null,
    },
    patient: { id: patient.id, first_name: patient.first_name, last_name: patient.last_name, mrn: patient.mrn, dob: patient.dob, gender: patient.gender },
    findings: findings.map(serializeFinding),
    treatments: treatments.map(serializeTreatment),
    counts: {
      active_findings: findings.filter((f) => f.status === 'active').length,
      planned: treatments.filter((t) => t.status === 'planned').length,
      completed: treatments.filter((t) => t.status === 'completed').length,
    },
  });
}));

// GET /api/patients/:patientId/dental/history?tooth=&limit= — patient timeline or per-tooth history
router.get('/history', asyncH(async (req, res) => {
  const { patient } = await loadContext(db, req);
  const limit = V.int(req.query.limit, 'limit', { min: 1, max: 300, def: 100 });
  const where = ['h.clinic_id = ?', 'h.patient_id = ?'];
  const params = [req.clinic.id, patient.id];
  if (req.query.tooth) {
    where.push('h.tooth_number = ?');
    params.push(D.validateTooth(req.query.tooth, 'tooth'));
  }
  const events = await db.q(`${HISTORY_SELECT} WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
    [...params, limit]);
  res.json({ events: events.map(serializeHistory) });
}));

// GET /api/patients/:patientId/dental/teeth/:tooth — tooth detail (findings, treatments, history)
router.get('/teeth/:tooth', asyncH(async (req, res) => {
  const { patient } = await loadContext(db, req);
  const tooth = D.validateTooth(req.params.tooth, 'tooth');
  const findings = await db.q(`${FINDING_SELECT} WHERE f.clinic_id = ? AND f.patient_id = ? AND f.tooth_number = ? ORDER BY f.id`, [req.clinic.id, patient.id, tooth]);
  const treatments = await db.q(`${TREATMENT_SELECT} WHERE t.clinic_id = ? AND t.patient_id = ? AND t.tooth_number = ? ORDER BY t.id`, [req.clinic.id, patient.id, tooth]);
  const history = await db.q(`${HISTORY_SELECT} WHERE h.clinic_id = ? AND h.patient_id = ? AND h.tooth_number = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 200`, [req.clinic.id, patient.id, tooth]);
  res.json({
    tooth_number: tooth,
    dentition: D.toothDentition(tooth),
    findings: findings.map(serializeFinding),
    treatments: treatments.map(serializeTreatment),
    history: history.map(serializeHistory),
  });
}));

// POST /api/patients/:patientId/dental/findings — document a current condition
router.post('/findings', asyncH(async (req, res) => {
  const body = req.body || {};
  const tooth = D.validateTooth(body.tooth_number);
  const condition = D.validateCondition(body.condition);
  const surfaces = D.normalizeSurfaces(body.surfaces);
  const note = V.str(body.note, 'note', { max: 2000 });
  const appointmentId = body.appointment_id ? V.int(body.appointment_id, 'appointment_id', { min: 1 }) : null;
  const recordId = body.record_id ? V.int(body.record_id, 'record_id', { min: 1 }) : null;
  if (condition === 'other' && !note) throw badRequest('A note is required for the "other" condition', { note: 'required_for_other' });

  const { patient, chart } = await loadContext(db, req, { persistChart: true });
  await D.validateLinks(db, { clinicId: req.clinic.id, patientId: patient.id, appointmentId, recordId });
  await D.assertNotContradictory(db, { clinicId: req.clinic.id, patientId: patient.id, tooth, condition, surfaces });

  const findingOut = await db.withTx(async (t) => {
    const created = await t.q1(`INSERT INTO dental_findings
      (clinic_id, patient_id, chart_id, tooth_number, dentition, condition, surfaces, note, appointment_id, record_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [req.clinic.id, patient.id, chart.id, tooth, D.toothDentition(tooth), condition, surfaces, note, appointmentId, recordId, req.user.id]);
    const id = created.id;
    const finding = await getOwnFinding(t, req.clinic.id, patient.id, id);
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id, tooth, dentition: finding.dentition,
      eventType: 'finding_created', entity: 'finding', entityId: id,
      newValue: { condition, surfaces, note }, appointmentId, recordId, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id, action: 'dental.finding.create',
      entity: 'dental_finding', entityId: id, details: { patient_id: patient.id, tooth, condition, surfaces },
    });
    return serializeFinding(finding);
  });
  res.status(201).json({ finding: findingOut });
}));

// PUT /api/patients/:patientId/dental/findings/:id — correct a finding (audited; reason required for condition changes)
router.put('/findings/:id', asyncH(async (req, res) => {
  const body = req.body || {};
  const { patient } = await loadContext(db, req);
  const existing = await getOwnFinding(db, req.clinic.id, patient.id, V.int(req.params.id, 'id', { required: true, min: 1 }));
  if (existing.status !== 'active') throw conflict('This finding is resolved; resolved findings are kept as history and cannot be edited.');

  const condition = body.condition !== undefined ? D.validateCondition(body.condition) : existing.condition;
  const surfaces = body.surfaces !== undefined ? D.normalizeSurfaces(body.surfaces) : existing.surfaces;
  const note = body.note !== undefined ? V.str(body.note, 'note', { max: 2000 }) : existing.note;
  const reason = V.str(body.reason, 'reason', { max: 500 });
  const conditionChanged = condition !== existing.condition || surfaces !== existing.surfaces;
  if (conditionChanged && !reason) {
    throw badRequest('A reason is required when correcting a documented condition or its surfaces', { reason: 'required_for_correction' });
  }
  if (condition === 'other' && !note) throw badRequest('A note is required for the "other" condition', { note: 'required_for_other' });
  if (!conditionChanged && note === existing.note) throw badRequest('Nothing to update');
  if (conditionChanged) {
    await D.assertNotContradictory(db, { clinicId: req.clinic.id, patientId: patient.id, tooth: existing.tooth_number, condition, surfaces, ignoreFindingId: existing.id });
  }

  const findingOut = await db.withTx(async (t) => {
    await t.exec('UPDATE dental_findings SET condition = ?, surfaces = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ? AND clinic_id = ?',
      [condition, surfaces, note, req.user.id, nowIso(), existing.id, req.clinic.id]);
    const finding = await getOwnFinding(t, req.clinic.id, patient.id, existing.id);
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id, tooth: finding.tooth_number, dentition: finding.dentition,
      eventType: conditionChanged ? 'correction' : 'finding_updated', entity: 'finding', entityId: finding.id,
      oldValue: { condition: existing.condition, surfaces: existing.surfaces, note: existing.note },
      newValue: { condition, surfaces, note }, reason, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id, action: 'dental.finding.update',
      entity: 'dental_finding', entityId: finding.id,
      details: { patient_id: patient.id, tooth: finding.tooth_number, from: existing.condition, to: condition, reason: reason || undefined },
    });
    return serializeFinding(finding);
  });
  res.json({ finding: findingOut });
}));

// POST /api/patients/:patientId/dental/findings/:id/resolve — e.g. caries resolved after treatment
router.post('/findings/:id/resolve', asyncH(async (req, res) => {
  const body = req.body || {};
  const { patient } = await loadContext(db, req);
  const existing = await getOwnFinding(db, req.clinic.id, patient.id, V.int(req.params.id, 'id', { required: true, min: 1 }));
  if (existing.status === 'resolved') throw conflict('This finding is already resolved.');
  const reason = V.str(body.reason, 'reason', { required: true, max: 500 });

  const findingOut = await db.withTx(async (t) => {
    await t.exec(`UPDATE dental_findings SET status = 'resolved', updated_by = ?, updated_at = ? WHERE id = ? AND clinic_id = ?`,
      [req.user.id, nowIso(), existing.id, req.clinic.id]);
    const finding = await getOwnFinding(t, req.clinic.id, patient.id, existing.id);
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id, tooth: finding.tooth_number, dentition: finding.dentition,
      eventType: 'finding_resolved', entity: 'finding', entityId: finding.id,
      oldValue: { status: 'active' }, newValue: { status: 'resolved' }, reason, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id, action: 'dental.finding.resolve',
      entity: 'dental_finding', entityId: finding.id,
      details: { patient_id: patient.id, tooth: finding.tooth_number, condition: finding.condition, reason },
    });
    return serializeFinding(finding);
  });
  res.json({ finding: findingOut });
}));

// POST /api/patients/:patientId/dental/treatments — plan a treatment (never alters current findings)
router.post('/treatments', asyncH(async (req, res) => {
  const body = req.body || {};
  const tooth = D.validateTooth(body.tooth_number);
  const procedure = D.validateProcedure(body.procedure);
  const surfaces = D.normalizeSurfaces(body.surfaces);
  const note = V.str(body.note, 'note', { max: 2000 });
  const appointmentId = body.appointment_id ? V.int(body.appointment_id, 'appointment_id', { min: 1 }) : null;
  const recordId = body.record_id ? V.int(body.record_id, 'record_id', { min: 1 }) : null;
  if (procedure === 'other' && !note) throw badRequest('A note is required for the "other" procedure', { note: 'required_for_other' });

  const { patient, chart } = await loadContext(db, req, { persistChart: true });
  await D.validateLinks(db, { clinicId: req.clinic.id, patientId: patient.id, appointmentId, recordId });
  const now = nowIso();
  const dup = await db.q1(`SELECT id FROM dental_treatments
    WHERE clinic_id = ? AND patient_id = ? AND tooth_number = ? AND procedure = ? AND surfaces = ? AND status = 'planned'`,
    [req.clinic.id, patient.id, tooth, procedure, surfaces]);
  if (dup) throw conflict(`An identical planned treatment already exists for tooth ${tooth} (#${dup.id}).`);

  const treatmentOut = await db.withTx(async (t) => {
    const created = await t.q1(`INSERT INTO dental_treatments
      (clinic_id, patient_id, chart_id, tooth_number, dentition, procedure, surfaces, note, appointment_id, record_id, planned_by, planned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [req.clinic.id, patient.id, chart.id, tooth, D.toothDentition(tooth), procedure, surfaces, note, appointmentId, recordId, req.user.id, now]);
    const treatment = await getOwnTreatment(t, req.clinic.id, patient.id, created.id);
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id, tooth, dentition: treatment.dentition,
      eventType: 'treatment_planned', entity: 'treatment', entityId: treatment.id,
      newValue: { procedure, surfaces, note, status: 'planned' }, appointmentId, recordId, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id, action: 'dental.treatment.plan',
      entity: 'dental_treatment', entityId: treatment.id, details: { patient_id: patient.id, tooth, procedure },
    });
    return serializeTreatment(treatment);
  });
  res.status(201).json({ treatment: treatmentOut });
}));

// PATCH /api/patients/:patientId/dental/treatments/:id/status
// {status: completed|cancelled|planned, reason?, completion_note?,
//  apply?: {condition, surfaces?, note?}, resolve?: [condition codes]}
// Completing can EXPLICITLY (never silently) apply a resulting finding and/or
// resolve addressed findings; every step is written to history + audit.
router.patch('/treatments/:id/status', asyncH(async (req, res) => {
  const body = req.body || {};
  const { patient } = await loadContext(db, req);
  const treatment = await getOwnTreatment(db, req.clinic.id, patient.id, V.int(req.params.id, 'id', { required: true, min: 1 }));
  const status = V.oneOf(body.status, 'status', ['planned', 'completed', 'cancelled', 'postponed'], { required: true });
  if (status === treatment.status) throw badRequest(`Treatment is already ${status}`);
  const reason = V.str(body.reason, 'reason', { max: 500 });
  const completionNote = V.str(body.completion_note, 'completion_note', { max: 2000 });
  // Reopening/cancelling a completed treatment is a correction: reason required.
  if ((treatment.status === 'completed' || status === 'cancelled') && !reason) {
    throw badRequest('A reason is required for this status change', { reason: 'required' });
  }
  let apply = null;
  if (status === 'completed' && body.apply) {
    apply = {
      condition: D.validateCondition(body.apply.condition, 'apply.condition'),
      surfaces: D.normalizeSurfaces(body.apply.surfaces, 'apply.surfaces'),
      note: V.str(body.apply.note, 'apply.note', { max: 2000 }),
    };
    if (apply.condition === 'other' && !apply.note) throw badRequest('A note is required for the "other" condition', { 'apply.note': 'required_for_other' });
  }
  let resolveCodes = [];
  if (status === 'completed' && body.resolve) {
    const arr = V.arrayField(body.resolve, 'resolve', { required: true });
    resolveCodes = [...new Set(arr.map((c) => D.validateCondition(c, 'resolve[]')))]
      .filter((c) => c !== 'healthy');
  }

  const now = nowIso();
  let result;
  try {
    result = await db.withTx(async (t) => {
    const applied = [];
    const resolved = [];
    if (status === 'completed') {
      if (apply) {
        await D.assertNotContradictory(t, { clinicId: req.clinic.id, patientId: patient.id, tooth: treatment.tooth_number, condition: apply.condition, surfaces: apply.surfaces });
        const created = await t.q1(`INSERT INTO dental_findings
          (clinic_id, patient_id, chart_id, tooth_number, dentition, condition, surfaces, note, appointment_id, record_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [req.clinic.id, patient.id, treatment.chart_id, treatment.tooth_number, treatment.dentition,
            apply.condition, apply.surfaces, apply.note, treatment.appointment_id, treatment.record_id, req.user.id]);
        const finding = await getOwnFinding(t, req.clinic.id, patient.id, created.id);
        await D.addHistory(t, {
          clinicId: req.clinic.id, patientId: patient.id, tooth: finding.tooth_number, dentition: finding.dentition,
          eventType: 'finding_created', entity: 'finding', entityId: finding.id,
          newValue: { condition: apply.condition, surfaces: apply.surfaces, note: apply.note, origin: `treatment #${treatment.id} completed` },
          reason: `Applied explicitly on completion of ${treatment.procedure} treatment #${treatment.id}`,
          userId: req.user.id,
        });
        applied.push(serializeFinding(finding));
      }
      for (const code of resolveCodes) {
        const rows = await t.q(`${FINDING_SELECT} WHERE f.clinic_id = ? AND f.patient_id = ? AND f.tooth_number = ? AND f.condition = ? AND f.status = 'active'`,
          [req.clinic.id, patient.id, treatment.tooth_number, code]);
        for (const row of rows) {
          await t.exec(`UPDATE dental_findings SET status = 'resolved', updated_by = ?, updated_at = ? WHERE id = ?`,
            [req.user.id, nowIso(), row.id]);
          const r = `Resolved by completed ${treatment.procedure} treatment #${treatment.id}`;
          await D.addHistory(t, {
            clinicId: req.clinic.id, patientId: patient.id, tooth: row.tooth_number, dentition: row.dentition,
            eventType: 'finding_resolved', entity: 'finding', entityId: row.id,
            oldValue: { status: 'active' }, newValue: { status: 'resolved' }, reason: r, userId: req.user.id,
          });
          resolved.push(serializeFinding(await getOwnFinding(t, req.clinic.id, patient.id, row.id)));
        }
      }
    }

    if (status === 'completed') {
      await t.exec(`UPDATE dental_treatments SET status = 'completed', completion_note = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [completionNote, req.user.id, now, nowIso(), treatment.id, req.clinic.id]);
      // Chart -> plans: a completed chart treatment satisfies matching open plan
      // items (same patient + tooth) so explicit session completion can verify
      // real clinical work. Cancelled/postponed treatments never link.
      await t.exec(`
        UPDATE treatment_plan_items i SET dental_treatment_id = ?, updated_at = ?
        FROM treatment_plans p
        WHERE i.plan_id = p.id AND p.clinic_id = ? AND p.patient_id = ?
          AND i.tooth_number = ? AND i.dental_treatment_id IS NULL
          AND i.status IN ('proposed', 'approved', 'scheduled')`,
        [treatment.id, nowIso(), req.clinic.id, patient.id, treatment.tooth_number]);
    } else if (status === 'cancelled' || status === 'postponed') {
      // Cancelled/postponed procedures NEVER update the documented tooth state.
      await t.exec(`UPDATE dental_treatments SET status = ?, completion_note = NULL, completed_by = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [status, nowIso(), treatment.id, req.clinic.id]);
    } else {
      await t.exec(`UPDATE dental_treatments SET status = 'planned', completion_note = NULL, completed_by = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [nowIso(), treatment.id, req.clinic.id]);
    }
    const updated = await getOwnTreatment(t, req.clinic.id, patient.id, treatment.id);
    const eventType = status === 'completed' ? 'treatment_completed' : status === 'cancelled' ? 'treatment_cancelled' : status === 'postponed' ? 'treatment_postponed' : 'treatment_reopened';
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id, tooth: updated.tooth_number, dentition: updated.dentition,
      eventType, entity: 'treatment', entityId: updated.id,
      oldValue: { status: treatment.status },
      newValue: { status, completion_note: completionNote || null, applied: applied.map((a) => a.id), resolved: resolved.map((r) => r.id) },
      reason: reason || undefined, note: completionNote || undefined, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id,
      action: status === 'completed' ? 'dental.treatment.complete' : status === 'cancelled' ? 'dental.treatment.cancel' : status === 'postponed' ? 'dental.treatment.postpone' : 'dental.treatment.reopen',
      entity: 'dental_treatment', entityId: updated.id,
      details: { patient_id: patient.id, tooth: updated.tooth_number, procedure: updated.procedure, from: treatment.status, to: status, reason: reason || undefined },
    });
    return { treatment: serializeTreatment(updated), applied_findings: applied, resolved_findings: resolved };
  });
  } catch (err) {
    if (err && err.code === '23505' && String(err.constraint || '').includes('uq_performed_once')) {
      throw conflict(`This ${treatment.procedure} procedure is already recorded as completed for tooth ${treatment.tooth_number} in the same encounter. Duplicate performed records are not allowed — reopen the original instead.`);
    }
    throw err;
  }
  res.json(result);
}));

// PUT /api/patients/:patientId/dental/config — dentition (always clinician-editable)
router.put('/config', asyncH(async (req, res) => {
  const body = req.body || {};
  const dentition = V.oneOf(body.dentition, 'dentition', D.DENTITIONS, { required: true });
  const { patient, chart } = await loadContext(db, req, { persistChart: true });
  if (chart.dentition === dentition) {
    return res.json({ chart: { id: chart.id, dentition: chart.dentition, dentition_suggested: chart.dentition_suggested ?? null, persisted: true, updated_at: chart.updated_at } });
  }
  const updated = await db.withTx(async (t) => {
    await t.exec('UPDATE dental_charts SET dentition = ?, updated_at = ? WHERE id = ? AND clinic_id = ?',
      [dentition, nowIso(), chart.id, req.clinic.id]);
    const fresh = await t.q1('SELECT * FROM dental_charts WHERE id = ?', [chart.id]);
    await D.addHistory(t, {
      clinicId: req.clinic.id, patientId: patient.id,
      eventType: 'chart_config', entity: 'chart', entityId: fresh.id,
      oldValue: { dentition: chart.dentition }, newValue: { dentition }, userId: req.user.id,
    });
    await audit(t, {
      clinicId: req.clinic.id, userId: req.user.id, action: 'dental.chart.config',
      entity: 'dental_chart', entityId: fresh.id, details: { patient_id: patient.id, from: chart.dentition, to: dentition },
    });
    return fresh;
  });
  res.json({ chart: { id: updated.id, dentition: updated.dentition, dentition_suggested: updated.dentition_suggested ?? null, persisted: true, updated_at: updated.updated_at } });
}));

module.exports = router;
