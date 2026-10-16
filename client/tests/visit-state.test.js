/**
 * Visit-state derivation tests (Stage J). Pure module — runs under plain
 * `node --test` with no framework added: npm test (client).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSteps, deriveActions, visitRecords, visitTreatments, visitPlans } from '../src/visitState.js';

const appt = (over = {}) => ({
  id: 10, patient_id: 3, status: 'scheduled', duration_min: 30,
  services: [{ service_id: 1, name: 'Consultation', duration_min: 30, price_cents: 15000 }],
  ...over,
});
const stepsOf = (input) => Object.fromEntries(deriveSteps(input).map((s) => [s.key, s.status]));

test('no appointment yet: every step is honestly unknown', () => {
  const s = stepsOf({ appointment: null });
  assert.equal(s.booking, 'unknown');
  assert.equal(s.performed, 'unknown');
  assert.deepEqual(deriveActions({ appointment: null, steps: [], roles: {} }), []);
});

test('fresh scheduled visit: booking done, nothing else started, payloads missing = unknown', () => {
  const s = stepsOf({ appointment: appt() });
  assert.equal(s.booking, 'completed');
  assert.equal(s.checkin, 'not_started');
  assert.equal(s.assessment, 'unknown'); // records not fetched/authorized
  assert.equal(s.billing, 'unknown');    // not a financial role
});

test('check-in and visit status drive the check-in step', () => {
  assert.equal(stepsOf({ appointment: appt({ status: 'checked_in' }) }).checkin, 'completed');
  assert.equal(stepsOf({ appointment: appt({ status: 'cancelled' }) }).checkin, 'not_applicable');
  assert.equal(stepsOf({ appointment: appt({ status: 'no_show' }) }).checkin, 'completed');
});

test('draft record = assessment in progress + documentation awaiting; finalized = completed', () => {
  const draft = [{ id: 1, appointment_id: 10, status: 'draft', follow_up: '' }];
  let s = stepsOf({ appointment: appt({ status: 'in_progress' }), records: draft });
  assert.equal(s.assessment, 'in_progress');
  assert.equal(s.documentation, 'awaiting');

  const final = [{ id: 1, appointment_id: 10, status: 'approved', follow_up: 'review in 6 months' }];
  s = stepsOf({ appointment: appt({ status: 'completed' }), records: final });
  assert.equal(s.assessment, 'completed');
  assert.equal(s.documentation, 'completed');
  assert.equal(s.followup, 'completed'); // real stored follow-up plan
});

test('records of OTHER appointments never count for this visit', () => {
  assert.equal(visitRecords([{ id: 9, appointment_id: 99 }], 10).length, 0);
  const s = stepsOf({ appointment: appt(), records: [{ id: 9, appointment_id: 99, status: 'approved' }] });
  assert.equal(s.assessment, 'not_started');
});

test('planned treatment is NOT performed (core clinical distinction)', () => {
  const dental = { findings: [], treatments: [{ id: 77, appointment_id: 10, record_id: null, status: 'planned', tooth_number: 36, procedure: 'filling' }] };
  const s = stepsOf({ appointment: appt(), dental });
  assert.equal(s.performed, 'in_progress', 'planned work must not render as performed');
  assert.equal(s.chart, 'in_progress');
});

test('completed treatment (linked via encounter) marks performed + chart completed', () => {
  const dental = {
    findings: [],
    treatments: [{ id: 77, appointment_id: null, record_id: 1, status: 'completed', tooth_number: 36, procedure: 'filling', completed_at: '2026-01-01T00:00:00Z' }],
  };
  const s = stepsOf({ appointment: appt(), records: [{ id: 1, appointment_id: 10, status: 'approved' }], dental });
  assert.equal(s.performed, 'completed');
  assert.equal(s.chart, 'completed');
  assert.equal(visitTreatments(dental, { appointmentId: 10, recordIds: [1] }).length, 1);
});

test('plans: session linked to this visit ties the plan; proposed = awaiting approval', () => {
  const plans = [{ id: 5, status: 'proposed', sessions: [{ id: 1, appointment_id: 10, status: 'planned' }], items: [] }];
  assert.equal(visitPlans(plans, { appointmentId: 10, treatmentIds: [] }).length, 1);
  const s = stepsOf({ appointment: appt(), plans });
  assert.equal(s.planning, 'awaiting');
});

test('billing mirrors server invoice state only; hidden roles get unknown', () => {
  const inv = (status) => [{ id: 1, appointment_id: 10, status, total_cents: 100, paid_cents: 0, balance_cents: 100 }];
  assert.equal(stepsOf({ appointment: appt(), invoices: [], canViewBilling: true }).billing, 'not_started');
  assert.equal(stepsOf({ appointment: appt(), invoices: inv('partial'), canViewBilling: true }).billing, 'in_progress');
  assert.equal(stepsOf({ appointment: appt(), invoices: inv('paid'), canViewBilling: true }).billing, 'completed');
  assert.equal(stepsOf({ appointment: appt(), invoices: inv('paid'), canViewBilling: false }).billing, 'unknown');
});

test('follow-up: not applicable unless the catalog or the record demands it', () => {
  assert.equal(stepsOf({ appointment: appt(), records: [] }).followup, 'not_applicable');
  const flagged = appt({ services: [{ service_id: 2, requires_followup: true }] });
  assert.equal(stepsOf({ appointment: flagged, records: [] }).followup, 'not_started');
});

test('actions respect role boundaries (UI mirror; server re-enforces)', () => {
  const steps = deriveSteps({ appointment: appt({ status: 'scheduled' }), records: [], dental: { findings: [], treatments: [] }, plans: [], invoices: [], canViewBilling: true });
  const reception = deriveActions({ appointment: appt({ status: 'scheduled' }), steps, roles: { scheduling: true, clinical: false, financial: false } });
  assert.ok(reception.some((a) => a.id === 'checkin'));
  assert.ok(!reception.some((a) => ['new-record', 'open-chart', 'create-invoice'].includes(a.id)));

  const doctor = deriveActions({ appointment: appt({ status: 'scheduled' }), steps, roles: { scheduling: true, clinical: true, financial: true } });
  assert.ok(doctor.some((a) => a.id === 'new-record'));
  // invoice creation only once the visit is actually billable (status gate)
  assert.ok(!doctor.some((a) => a.id === 'create-invoice'));
  const doneAppt = appt({ status: 'completed' });
  const doneSteps = deriveSteps({ appointment: doneAppt, records: [{ id: 1, appointment_id: 10, status: 'approved' }], dental: { findings: [], treatments: [] }, plans: [], invoices: [], canViewBilling: true });
  const doctorDone = deriveActions({ appointment: doneAppt, steps: doneSteps, roles: { scheduling: true, clinical: true, financial: true } });
  assert.ok(doctorDone.some((a) => a.id === 'create-invoice'));

  const done = deriveSteps({ appointment: appt({ status: 'completed' }), records: [{ id: 1, appointment_id: 10, status: 'approved' }], dental: { findings: [], treatments: [] }, plans: [], invoices: [], canViewBilling: false });
  assert.ok(!deriveActions({ appointment: appt({ status: 'completed' }), steps: done, roles: { scheduling: true, clinical: true, financial: false } }).some((a) => a.id === 'checkin'));
});
