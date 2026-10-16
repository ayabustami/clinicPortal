'use strict';
/**
 * Dental chart (odontogram) domain logic: FDI numbering, catalogs,
 * validation and the clinical-safety rules shared by the routes.
 *
 * Layers (kept strictly separate):
 *   A. current findings   -> dental_findings (status active/resolved)
 *   B. planned treatments -> dental_treatments status='planned'
 *   C. completed work     -> dental_treatments status='completed'
 * Every change appends a dental_history row; nothing is silently overwritten.
 *
 * Async: db-facing functions take a runner `t` (pool helpers or transaction).
 */
const { badRequest, conflict, notFound } = require('../util/errors');
const { nowIso } = require('../util/time');

/* ---------------- FDI numbering ---------------- */

// Permanent: quadrants 1-4 (UR, UL, LL, LR), positions 1-8.
// Primary:   quadrants 5-8 (UR, UL, LL, LR), positions 1-5.
const PERMANENT_TEETH = [];
const PRIMARY_TEETH = [];
for (let q = 1; q <= 4; q++) for (let p = 1; p <= 8; p++) PERMANENT_TEETH.push(q * 10 + p);
for (let q = 5; q <= 8; q++) for (let p = 1; p <= 5; p++) PRIMARY_TEETH.push(q * 10 + p);
const VALID_TEETH = new Set([...PERMANENT_TEETH, ...PRIMARY_TEETH]);

function isValidTooth(n) { return Number.isInteger(n) && VALID_TEETH.has(n); }
function toothDentition(n) {
  if (!isValidTooth(n)) return null;
  return Math.floor(n / 10) <= 4 ? 'permanent' : 'primary';
}

/* ---------------- catalogs ---------------- */

const CONDITIONS = ['healthy', 'caries', 'filled', 'crown', 'missing', 'extracted',
  'root_canal', 'fractured', 'implant', 'bridge_pontic', 'bridge_abutment', 'impacted', 'other'];
const PROCEDURES = ['filling', 'crown', 'extraction', 'root_canal', 'implant', 'bridge',
  'cleaning', 'fluoride', 'other'];
const SURFACES = ['M', 'D', 'O', 'B', 'L'];
const DENTITIONS = ['permanent', 'primary', 'mixed'];

/**
 * Clinical-safety matrix. When a tooth already carries one of the KEY active
 * conditions, adding any of the VALUE conditions is contradictory and is
 * rejected (409) for clinician review — never silently resolved.
 */
const CONTRADICTIONS = {
  missing: ['healthy', 'caries', 'filled', 'crown', 'root_canal', 'fractured', 'impacted', 'extracted'],
  extracted: ['healthy', 'caries', 'filled', 'crown', 'root_canal', 'fractured', 'impacted', 'missing'],
  implant: ['caries', 'filled', 'root_canal', 'fractured', 'impacted'],
  healthy: ['caries', 'missing', 'extracted', 'fractured', 'impacted'],
};

/* ---------------- validation helpers ---------------- */

function validateTooth(raw, field = 'tooth_number') {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(n)) {
    throw badRequest(`${field} is required and must be an integer`, { [field]: 'required' });
  }
  if (!isValidTooth(n)) {
    throw badRequest(`${field} ${raw} is not a valid FDI tooth number (11-18, 21-28, 31-38, 41-48 permanent; 51-55, 61-65, 71-75, 81-85 primary)`, { [field]: 'invalid_fdi' });
  }
  return n;
}

/** Normalize surfaces: null/''/[] -> '' (whole tooth); else sorted subset of M,D,O,B,L. */
function normalizeSurfaces(raw, field = 'surfaces') {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return '';
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const clean = list.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return '';
  for (const s of clean) {
    if (!SURFACES.includes(s)) throw badRequest(`${field}: "${s}" is not a valid surface (M, D, O, B, L)`, { [field]: 'invalid_surface' });
  }
  const unique = [...new Set(clean)].sort((a, b) => SURFACES.indexOf(a) - SURFACES.indexOf(b));
  return unique.join(',');
}

function validateCondition(raw, field = 'condition') {
  const v = String(raw || '').trim().toLowerCase();
  if (!CONDITIONS.includes(v)) throw badRequest(`${field} must be one of: ${CONDITIONS.join(', ')}`, { [field]: 'invalid_condition' });
  return v;
}

function validateProcedure(raw, field = 'procedure') {
  const v = String(raw || '').trim().toLowerCase();
  if (!PROCEDURES.includes(v)) throw badRequest(`${field} must be one of: ${PROCEDURES.join(', ')}`, { [field]: 'invalid_procedure' });
  return v;
}

/* ---------------- patient / chart access ---------------- */

/** Tenant isolation: same 404 for unknown and cross-clinic patient ids. */
async function getOwnPatient(t, clinicId, patientId) {
  const patient = await t.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [patientId, clinicId]);
  if (!patient) throw notFound('Patient not found');
  return patient;
}

/** Lazily create the chart row (dentition suggestion from dob is informational). */
async function ensureChart(t, { clinicId, patient, userId }) {
  let chart = await t.q1('SELECT * FROM dental_charts WHERE clinic_id = ? AND patient_id = ?', [clinicId, patient.id]);
  if (chart) return { chart, created: false };
  const suggested = suggestDentition(patient.dob);
  chart = await t.q1(
    `INSERT INTO dental_charts (clinic_id, patient_id, dentition, dentition_suggested, created_by)
     VALUES (?, ?, 'permanent', ?, ?) RETURNING *`,
    [clinicId, patient.id, suggested, userId]
  );
  return { chart, created: true };
}

/**
 * Age-based dentition suggestion ONLY (never an assumption about dental
 * development): <=5y primary, 6-12y mixed, >=13y permanent, null without dob.
 */
function suggestDentition(dob) {
  if (!dob) return null;
  const birth = new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  if (age < 0 || age > 130) return null;
  if (age <= 5) return 'primary';
  if (age <= 12) return 'mixed';
  return 'permanent';
}

/* ---------------- contradiction check ---------------- */

/** Reject contradictory or exact-duplicate new findings against the tooth's active findings. */
async function assertNotContradictory(t, { clinicId, patientId, tooth, condition, surfaces = '', ignoreFindingId = null }) {
  const rows = await t.q(
    `SELECT id, condition, surfaces FROM dental_findings
     WHERE clinic_id = ? AND patient_id = ? AND tooth_number = ? AND status = 'active'`,
    [clinicId, patientId, tooth]
  );
  const active = rows.filter((f) => String(f.id) !== String(ignoreFindingId));
  for (const f of active) {
    const blocked = CONTRADICTIONS[f.condition] || [];
    if (blocked.includes(condition)) {
      throw conflict(`Tooth ${tooth} is documented as "${f.condition}" — adding "${condition}" would contradict it. Resolve the existing finding first (the change is kept in history).`);
    }
    // reverse direction: e.g. an active caries cannot gain 'healthy'
    const reverseBlocked = CONTRADICTIONS[condition] || [];
    if (reverseBlocked.includes(f.condition)) {
      throw conflict(`Tooth ${tooth} already has an active "${f.condition}" finding — "${condition}" cannot be added alongside it. Resolve the existing finding first.`);
    }
  }
  // duplicate-submission guard (also backed by the partial unique index)
  if (active.some((f) => f.condition === condition && f.surfaces === surfaces)) {
    throw conflict(`Tooth ${tooth} already has an active "${condition}" finding${surfaces ? ` on surfaces ${surfaces}` : ''}.`);
  }
}

/* ---------------- history ---------------- */

async function addHistory(t, row) {
  await t.exec(
    `INSERT INTO dental_history
      (clinic_id, patient_id, tooth_number, dentition, event_type, entity, entity_id,
       old_value, new_value, reason, note, appointment_id, record_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.clinicId, row.patientId, row.tooth ?? null, row.dentition ?? null, row.eventType,
      row.entity, row.entityId,
      row.oldValue ? JSON.stringify(row.oldValue) : null,
      row.newValue ? JSON.stringify(row.newValue) : null,
      row.reason || null, row.note || null,
      row.appointmentId ?? null, row.recordId ?? null,
      row.userId ?? null, nowIso()]
  );
}

/** Optional FK existence checks (visit/record links must belong to the same clinic+patient). */
async function validateLinks(t, { clinicId, patientId, appointmentId, recordId }) {
  if (appointmentId) {
    const a = await t.q1('SELECT id FROM appointments WHERE id = ? AND clinic_id = ? AND patient_id = ?', [appointmentId, clinicId, patientId]);
    if (!a) throw badRequest('appointment_id does not match an appointment of this patient', { appointment_id: 'invalid' });
  }
  if (recordId) {
    const r = await t.q1('SELECT id FROM medical_records WHERE id = ? AND clinic_id = ? AND patient_id = ?', [recordId, clinicId, patientId]);
    if (!r) throw badRequest('record_id does not match a medical record of this patient', { record_id: 'invalid' });
  }
}

module.exports = {
  PERMANENT_TEETH, PRIMARY_TEETH, VALID_TEETH,
  CONDITIONS, PROCEDURES, SURFACES, DENTITIONS, CONTRADICTIONS,
  isValidTooth, toothDentition,
  validateTooth, normalizeSurfaces, validateCondition, validateProcedure,
  getOwnPatient, ensureChart, suggestDentition,
  assertNotContradictory, addHistory, validateLinks,
};
