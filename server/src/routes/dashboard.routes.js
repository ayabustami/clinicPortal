'use strict';
const router = require('express').Router();
const { q, q1 } = require('../db');
const { requireAuth, requireClinic, PERMS } = require('../auth');
const { asyncH } = require('../util/errors');
const { wallParts, fmtDateInTz, todayLocalDate, wallToUtc, addMinutes } = require('../util/time');

// GET /api/dashboard/summary
// Financial fields are only returned to roles in PERMS.financial (owner/accountant),
// consistent with revenue-report permissions. Other roles receive no financial data.
router.get('/summary', requireAuth, requireClinic, asyncH(async (req, res) => {
  const clinic = req.clinic;
  const tz = clinic.timezone;
  const todayLocal = todayLocalDate(tz);
  const canSeeFinancials = PERMS.financial.includes(req.user.role);
  const canSeeBalances = PERMS.financial_view.includes(req.user.role);
  const canSeeClinical = PERMS.clinical.includes(req.user.role);

  // Local day boundaries in UTC
  const dayStartUtc = wallToUtc(`${todayLocal} 00:00`, tz);
  const dayEndUtc = addMinutes(dayStartUtc, 24 * 60);

  const range = (extra = '') => `clinic_id = ? AND start_at >= ?::timestamptz AND start_at < ?::timestamptz ${extra}`;
  const dayParams = [clinic.id, dayStartUtc.toISOString(), dayEndUtc.toISOString()];

  const nowIso = new Date().toISOString();
  const monthIso = new Date(Date.now() - 29 * 86400000).toISOString();

  // All independent aggregates/lists run concurrently — the dashboard used to
  // pay ~14 sequential round trips before responding.
  const [todayApptsR, upcomingR, totalPatientsR, activeDoctorsR, activeStaffR, statusRows] = await Promise.all([
    q1(`SELECT COUNT(*) AS c FROM appointments WHERE ${range("AND status NOT IN ('cancelled','no_show')")}`, dayParams),
    q1(`SELECT COUNT(*) AS c FROM appointments
        WHERE clinic_id = ? AND start_at >= ?::timestamptz AND status IN ('scheduled','confirmed')`, [clinic.id, nowIso]),
    q1('SELECT COUNT(*) AS c FROM patients WHERE clinic_id = ? AND is_active = 1', [clinic.id]),
    q1('SELECT COUNT(*) AS c FROM doctors WHERE clinic_id = ? AND is_active = 1', [clinic.id]),
    q1("SELECT COUNT(*) AS c FROM users WHERE clinic_id = ? AND is_active = 1 AND role != 'doctor'", [clinic.id]),
    q(`SELECT status, COUNT(*)::int AS c FROM appointments
       WHERE clinic_id = ? AND start_at >= ?::timestamptz AND start_at < ?::timestamptz
       GROUP BY status`, dayParams),
  ]);
  const todayAppts = Number(todayApptsR.c);
  const upcoming = Number(upcomingR.c);
  const totalPatients = Number(totalPatientsR.c);
  const activeDoctors = Number(activeDoctorsR.c);
  const activeStaff = Number(activeStaffR.c);

  let revenue = null;
  if (canSeeFinancials) {
    const totalRev = Number((await q1(`SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END),0) AS c FROM payments WHERE clinic_id = ?`, [clinic.id])).c);
    const outstanding = Number((await q1(`
      SELECT COALESCE(SUM(i.total_cents - COALESCE(pay.net, 0)), 0) AS c
      FROM invoices i
      LEFT JOIN (
        SELECT invoice_id, SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END) AS net
        FROM payments WHERE clinic_id = ? GROUP BY invoice_id
      ) pay ON pay.invoice_id = i.id
      WHERE i.clinic_id = ? AND i.status != 'paid'
    `, [clinic.id, clinic.id])).c);
    const monthRevenue = Number((await q1(`
      SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END),0) AS c FROM payments
      WHERE clinic_id = ? AND paid_at >= ?::timestamptz
    `, [clinic.id, monthIso])).c);
    revenue = { total_cents: totalRev, last_30_days_cents: monthRevenue, outstanding_cents: outstanding };
  }

  // Waiting room = checked-in patients right now; in treatment = in_progress.
  const [waitingRows, inTreatmentRows] = await Promise.all([q(`
    SELECT a.id, a.patient_id, a.start_at, a.duration_min,
      p.first_name || ' ' || p.last_name AS patient_name,
      d.name AS doctor_name, s.name AS service_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.clinic_id = ? AND a.status = 'checked_in'
      AND a.start_at >= ?::timestamptz AND a.start_at < ?::timestamptz
    ORDER BY a.start_at ASC LIMIT 30
  `, dayParams), q(`
    SELECT a.id, a.patient_id, a.start_at, a.duration_min,
      p.first_name || ' ' || p.last_name AS patient_name,
      d.name AS doctor_name, s.name AS service_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.clinic_id = ? AND a.status = 'in_progress'
      AND a.start_at >= ?::timestamptz AND a.start_at < ?::timestamptz
    ORDER BY a.start_at ASC LIMIT 30
  `, dayParams)]);
  const waitingNow = waitingRows.map((r) => ({ ...r, local_time: wallParts(new Date(r.start_at), tz).time }));
  const inTreatment = inTreatmentRows.map((r) => ({ ...r, local_time: wallParts(new Date(r.start_at), tz).time }));

  // Clinical task queue: incomplete notes, plans awaiting approval, sessions
  // of active plans that still need scheduling. All from real records.
  let clinicalTasks = null;
  if (canSeeClinical) {
    const [draftsR, pendingPlansR, unscheduledSessionsR, followUpsR, pendingPlanRows, unscheduledSessionRows] = await Promise.all([
      q1(`SELECT COUNT(*) AS c FROM medical_records WHERE clinic_id = ? AND status = 'draft'`, [clinic.id]),
      q1(`SELECT COUNT(*) AS c FROM treatment_plans WHERE clinic_id = ? AND status = 'pending_approval'`, [clinic.id]),
      q1(`SELECT COUNT(*) AS c FROM treatment_sessions ts
          JOIN treatment_plans tp ON tp.id = ts.plan_id
          WHERE tp.clinic_id = ? AND tp.status IN ('approved','in_progress') AND ts.status = 'planned'`, [clinic.id]),
      q1(`SELECT COUNT(*) AS c FROM appointments
          WHERE clinic_id = ? AND appointment_type = 'follow_up' AND status IN ('scheduled','confirmed')
            AND start_at >= ?::timestamptz`, [clinic.id, nowIso]),
      // Bounded row lists so the dashboard can render the task queue without
      // pulling every plan/session into the browser.
      q(`
      SELECT tp.id, tp.patient_id, p.first_name || ' ' || p.last_name AS patient_name, tp.title
      FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
      WHERE tp.clinic_id = ? AND tp.status = 'pending_approval'
      ORDER BY tp.updated_at DESC LIMIT 8
    `, [clinic.id]),
      q(`
      SELECT ts.id AS session_id, ts.title, ts.plan_id, tp.patient_id,
        p.first_name || ' ' || p.last_name AS patient_name,
        (SELECT COUNT(*) FROM treatment_plan_items i WHERE i.session_id = ts.id AND i.status NOT IN ('cancelled'))::int AS item_count
      FROM treatment_sessions ts
      JOIN treatment_plans tp ON tp.id = ts.plan_id
      JOIN patients p ON p.id = tp.patient_id
      WHERE tp.clinic_id = ? AND tp.status IN ('approved','in_progress') AND ts.status = 'planned'
      ORDER BY ts.id LIMIT 8
    `, [clinic.id]),
    ]);
    const drafts = Number(draftsR.c);
    const pendingPlans = Number(pendingPlansR.c);
    const unscheduledSessions = Number(unscheduledSessionsR.c);
    const followUps = Number(followUpsR.c);
    clinicalTasks = {
      draft_records: drafts, pending_plans: pendingPlans, unscheduled_sessions: unscheduledSessions, upcoming_follow_ups: followUps,
      pending_plan_rows: pendingPlanRows, unscheduled_session_rows: unscheduledSessionRows,
    };
  }

  const [todaysRows, upcomingRows, recentActivity] = await Promise.all([q(`
    SELECT a.id, a.patient_id, a.start_at, a.duration_min, a.status,
      p.first_name || ' ' || p.last_name AS patient_name,
      d.name AS doctor_name, s.name AS service_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.clinic_id = ? AND a.start_at >= ?::timestamptz AND a.start_at < ?::timestamptz AND a.status NOT IN ('cancelled')
    ORDER BY a.start_at ASC LIMIT 20
  `, dayParams), q(`
    SELECT a.id, a.patient_id, a.start_at, a.status,
      p.first_name || ' ' || p.last_name AS patient_name,
      d.name AS doctor_name, s.name AS service_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.clinic_id = ? AND a.start_at >= ?::timestamptz AND a.status IN ('scheduled','confirmed')
    ORDER BY a.start_at ASC LIMIT 8
  `, [clinic.id, nowIso]), q(`
    SELECT kind, message, created_at FROM activity
    WHERE clinic_id = ? ORDER BY id DESC LIMIT 10
  `, [clinic.id])]);
  const todaysList = todaysRows.map((r) => ({ ...r, local_time: wallParts(new Date(r.start_at), tz).time }));
  const upcomingList = upcomingRows.map((r) => ({
    ...r,
    local_date: fmtDateInTz(new Date(r.start_at), tz),
    local_time: wallParts(new Date(r.start_at), tz).time,
  }));

  if (canSeeBalances && todaysList.length) {
    const ids = todaysList.map((r) => r.patient_id);
    // Single bounded aggregation (CTE) instead of a correlated sub-select per invoice.
    const bals = await q(`
      WITH inv AS (
        SELECT id, patient_id, total_cents FROM invoices
        WHERE clinic_id = ? AND status != 'paid' AND patient_id = ANY(?::int[])
      ),
      pay AS (
        SELECT pm.invoice_id, SUM(CASE WHEN pm.type = 'payment' THEN pm.amount_cents ELSE -pm.amount_cents END) AS net
        FROM payments pm WHERE pm.invoice_id IN (SELECT id FROM inv) GROUP BY pm.invoice_id
      )
      SELECT inv.patient_id, COALESCE(SUM(inv.total_cents - COALESCE(pay.net, 0)), 0)::bigint AS bal
      FROM inv LEFT JOIN pay ON pay.invoice_id = inv.id
      GROUP BY inv.patient_id
    `, [clinic.id, ids]);
    const byPatient = new Map(bals.map((b) => [b.patient_id, Number(b.bal)]));
    for (const r of todaysList) {
      r.patient_balance_cents = byPatient.get(r.patient_id) || 0;
    }
  }


  res.json({
    today: { appointments: todayAppts, list: todaysList },
    upcoming: { count: upcoming, list: upcomingList },
    patients: totalPatients,
    active_doctors: activeDoctors,
    active_staff: activeStaff,
    statuses: statusRows,
    revenue,
    waiting_now: waitingNow,
    in_treatment: inTreatment,
    clinical_tasks: clinicalTasks,
    activity: recentActivity,
    local_date: todayLocal,
  });
}));

module.exports = router;
