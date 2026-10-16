/**
 * Visit Workspace state derivation — pure functions, no React, no fetching.
 *
 * The server stays authoritative for every clinical/financial fact; this
 * module only *derives a presentation model* from payloads that were already
 * fetched through existing authorized endpoints:
 *   appointment  GET /api/appointments/:id        (services snapshot, status…)
 *   records      GET /api/records?patient_id=…    (filtered to this visit)
 *   dental       GET /api/patients/:pid/dental    (findings, treatments, summary)
 *   plans        GET /api/plans?patient_id=…      (items + sessions)
 *   invoices     GET /api/invoices?patient_id=…   (server-computed balances)
 *
 * Rules honoured here (mirrors of server semantics, never replacements):
 *  - a treatment plan item being proposed/approved/scheduled ≠ performed;
 *    only dental_treatments with status 'completed' count as performed;
 *  - a saved record is a draft until status === 'approved' (finalized);
 *  - billing states come from server-provided status/balance_cents only;
 *  - anything the payloads cannot prove renders as 'unknown', never as done.
 *
 * Step statuses: not_started | in_progress | awaiting | completed |
 *                not_applicable | unknown
 */

export const STEP_KEYS = [
  'booking', 'checkin', 'assessment', 'chart', 'planning',
  'performed', 'documentation', 'followup', 'billing',
];

const DONE_APPT = ['checked_in', 'in_progress', 'completed'];
const VISIT_HELD = ['in_progress', 'completed'];

function has(v) { return v !== undefined && v !== null; }

/** Treatments tied to THIS visit (performed work links to the encounter). */
export function visitTreatments(dental, { appointmentId, recordIds }) {
  const list = dental?.treatments || [];
  return list.filter((t) =>
    t.appointment_id === appointmentId || (has(t.record_id) && recordIds.includes(t.record_id)));
}

export function visitRecords(records, appointmentId) {
  return (records || []).filter((r) => r.appointment_id === appointmentId);
}

export function visitPlans(plans, { appointmentId, treatmentIds }) {
  return (plans || []).filter((p) => {
    const sessionHit = (p.sessions || []).some((s) => s.appointment_id === appointmentId);
    const itemHit = (p.items || []).some((i) => has(i.dental_treatment_id) && treatmentIds.includes(i.dental_treatment_id));
    return sessionHit || itemHit || p.appointment_id === appointmentId;
  });
}

/**
 * Derive the workflow overview. Every branch is backed by a persisted field;
 * `unknown` is returned whenever a payload is missing (fetch failed/skipped).
 */
export function deriveSteps(input) {
  const { appointment: a, records, dental, plans, invoices, canViewBilling } = input;
  if (!a) return STEP_KEYS.map((key) => ({ key, status: 'unknown', evidence: {} }));

  const recs = visitRecords(records, a.id);
  const recordIds = recs.map((r) => r.id);
  const treats = visitTreatments(dental, { appointmentId: a.id, recordIds });
  const treatmentIds = treats.map((t) => t.id);
  const vPlans = visitPlans(plans, { appointmentId: a.id, treatmentIds });
  const invs = (invoices || []).filter((i) => i.appointment_id === a.id);

  const finalized = recs.filter((r) => r.status === 'approved');
  const drafts = recs.filter((r) => r.status === 'draft');
  const planned = treats.filter((t) => t.status === 'planned');
  const completed = treats.filter((t) => t.status === 'completed');
  const cancelled = treats.filter((t) => ['cancelled', 'postponed'].includes(t.status));
  const activeFindings = (dental?.findings || []).filter((f) => f.status === 'active');
  const planApproved = vPlans.some((p) => ['approved', 'in_progress'].includes(p.status));
  const planProposed = vPlans.some((p) => p.status === 'proposed' || p.status === 'draft');
  const sessionsDone = vPlans.flatMap((p) => p.sessions || []).filter((s) => s.status === 'completed');
  const followUpPlanned = finalized.some((r) => (r.follow_up || '').trim().length > 0)
    || vPlans.some((p) => (p.sessions || []).some((s) => s.status === 'planned'));
  const requiresFollowup = (a.services || []).some((s) => s.requires_followup);

  const steps = [];
  steps.push({ key: 'booking', status: 'completed', evidence: { services: (a.services || []).length } });
  steps.push({
    key: 'checkin',
    status: a.status === 'cancelled' ? 'not_applicable'
      : a.status === 'no_show' ? 'completed'
        : DONE_APPT.includes(a.status) ? 'completed' : 'not_started',
    evidence: { status: a.status },
  });
  steps.push({
    key: 'assessment',
    status: records === undefined ? 'unknown'
      : finalized.length ? 'completed'
        : drafts.length ? 'in_progress'
          : recs.length ? 'in_progress' : 'not_started',
    evidence: { drafts: drafts.length, finalized: finalized.length },
  });
  steps.push({
    key: 'chart',
    status: dental === undefined ? 'unknown'
      : treats.length || activeFindings.length ? (completed.length ? 'completed' : 'in_progress')
        : 'not_started',
    evidence: { findings: activeFindings.length, treatments: treats.length },
  });
  steps.push({
    key: 'planning',
    status: plans === undefined ? 'unknown'
      : vPlans.length === 0 ? 'not_started'
        : planApproved || sessionsDone.length ? (sessionsDone.length && sessionsDone.length === vPlans.flatMap((p) => p.sessions || []).length ? 'completed' : 'in_progress')
          : planProposed ? 'awaiting' : 'in_progress',
    evidence: { plans: vPlans.length, sessionsDone: sessionsDone.length },
  });
  steps.push({
    key: 'performed',
    status: dental === undefined ? 'unknown'
      : completed.length ? 'completed'
        : planned.length ? 'in_progress'
          : cancelled.length ? 'not_applicable' : 'not_started',
    evidence: { completed: completed.length, planned: planned.length },
  });
  steps.push({
    key: 'documentation',
    status: records === undefined ? 'unknown'
      : finalized.length ? 'completed'
        : drafts.length ? 'awaiting'
          : VISIT_HELD.includes(a.status) ? 'in_progress' : 'not_started',
    evidence: { finalized: finalized.length, drafts: drafts.length },
  });
  steps.push({
    key: 'followup',
    status: requiresFollowup || followUpPlanned
      ? (followUpPlanned ? 'completed' : 'not_started')
      : 'not_applicable',
    evidence: { requiresFollowup, followUpPlanned },
  });
  steps.push({
    key: 'billing',
    status: !canViewBilling ? 'unknown'
      : invoices === undefined ? 'unknown'
        : invs.length === 0 ? 'not_started'
          : invs.every((i) => i.status === 'paid') ? 'completed'
            : 'in_progress',
    evidence: { invoices: invs.length },
  });
  return steps;
}

/**
 * Contextual next actions. Pure visibility rules — the server re-checks every
 * permission when an action is actually invoked.
 */
export function deriveActions(input) {
  const { appointment: a, steps, roles, invoices } = input;
  if (!a) return [];
  const step = (k) => steps.find((s) => s.key === k)?.status;
  const acts = [];
  const open = !['cancelled', 'no_show', 'completed'].includes(a.status);

  if (open && roles.scheduling && ['scheduled', 'confirmed'].includes(a.status)) acts.push({ id: 'checkin', kind: 'status', status: 'checked_in', labelKey: 'visit.action.checkin' });
  if (open && roles.clinical && a.status === 'checked_in') acts.push({ id: 'start', kind: 'status', status: 'in_progress', labelKey: 'visit.action.start' });
  if (roles.clinical && step('assessment') === 'not_started') acts.push({ id: 'new-record', kind: 'record-new', labelKey: 'visit.action.newRecord' });
  if (roles.clinical && step('assessment') === 'in_progress') acts.push({ id: 'continue-record', kind: 'record-open-draft', labelKey: 'visit.action.continueRecord' });
  if (roles.clinical && step('chart') !== 'unknown') acts.push({ id: 'open-chart', kind: 'link', to: 'dental', labelKey: 'visit.action.openChart' });
  if (roles.clinical && step('planning') === 'not_started') acts.push({ id: 'new-plan', kind: 'link', to: 'plans-new', labelKey: 'visit.action.newPlan' });
  if (roles.clinical && step('planning') === 'awaiting') acts.push({ id: 'review-plan', kind: 'link', to: 'plans', labelKey: 'visit.action.reviewPlan' });
  if (open && roles.clinical && a.status === 'in_progress') acts.push({ id: 'complete-visit', kind: 'status', status: 'completed', labelKey: 'visit.action.completeVisit' });
  if (roles.clinical && step('documentation') === 'awaiting') acts.push({ id: 'finalize', kind: 'record-open-draft', labelKey: 'visit.action.finalize' });
  if (step('followup') === 'not_started' && roles.scheduling) acts.push({ id: 'book-followup', kind: 'book-followup', labelKey: 'visit.action.bookFollowup' });
  if (roles.financial && step('billing') === 'not_started' && ['completed', 'checked_in', 'in_progress'].includes(a.status)) {
    acts.push({ id: 'create-invoice', kind: 'link', to: 'invoices-new', labelKey: 'visit.action.createInvoice' });
  }
  if (roles.financial && step('billing') === 'in_progress' && (invoices || []).some((i) => i.appointment_id === a.id && i.status !== 'paid')) {
    acts.push({ id: 'review-invoice', kind: 'link', to: 'invoices', labelKey: 'visit.action.reviewInvoice' });
  }
  return acts;
}
