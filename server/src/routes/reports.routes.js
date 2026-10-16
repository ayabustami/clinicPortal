'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const V = require('../util/validate');
const { asyncH, badRequest } = require('../util/errors');
const { wallToUtc, addMinutes, wallParts } = require('../util/time');

function parseRange(req, tz) {
  const from = V.isoDate(req.query.from, 'from');
  const to = V.isoDate(req.query.to, 'to');
  if (from && to && from > to) throw badRequest('from must be on or before to');
  const startUtc = from ? wallToUtc(`${from} 00:00`, tz) : wallToUtc(`2000-01-01 00:00`, tz);
  const endUtc = to ? addMinutes(wallToUtc(`${to} 00:00`, tz), 24 * 60) : addMinutes(wallToUtc(`2999-01-01 00:00`, tz), 24 * 60);
  return { from, to, startUtc, endUtc };
}

function sendCsv(res, filename, headers, rows) {
  // Formula-injection guard: neutralize cells starting with = + - @ or tab/CR
  // (documented strategy: prefix with a single quote, per OWASP CSV guidance).
  const DANGEROUS = /^[=+\-@\t\r]/;
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (DANGEROUS.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // UTF-8 BOM so Excel opens Arabic text correctly.
  const csv = '\uFEFF' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// GET /api/reports/appointments?from=&to=&format=csv
router.get('/appointments', requireAuth, requireClinic, requireRole('owner', 'receptionist', 'accountant'), asyncH(async (req, res) => {
  const tz = req.clinic.timezone;
  const { startUtc, endUtc } = parseRange(req, tz);
  const rows = await db.q(`
    SELECT a.id, a.start_at, a.duration_min, a.status,
      p.first_name || ' ' || p.last_name AS patient_name, p.mrn,
      d.name AS doctor_name, s.name AS service_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.clinic_id = ? AND a.start_at >= ?::timestamptz AND a.start_at < ?::timestamptz
    ORDER BY a.start_at
  `, [req.clinic.id, startUtc.toISOString(), endUtc.toISOString()]);

  if (req.query.format === 'csv') {
    return sendCsv(res, 'appointments-report.csv',
      ['Date', 'Time', 'Duration (min)', 'Status', 'Patient', 'MRN', 'Doctor', 'Service'],
      rows.map((r) => {
        const w = wallParts(new Date(r.start_at), tz);
        return [w.date, w.time, r.duration_min, r.status, r.patient_name, r.mrn, r.doctor_name, r.service_name];
      }));
  }

  const byStatus = {};
  const byDoctor = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byDoctor[r.doctor_name] = (byDoctor[r.doctor_name] || 0) + 1;
  }
  res.json({ total: rows.length, by_status: byStatus, by_doctor: byDoctor, appointments: rows.slice(0, 500) });
}));

// GET /api/reports/revenue?from=&to=&format=csv
router.get('/revenue', requireAuth, requireClinic, requireRole('owner', 'accountant'), asyncH(async (req, res) => {
  const tz = req.clinic.timezone;
  const { startUtc, endUtc } = parseRange(req, tz);

  const payments = await db.q(`
    SELECT pm.amount_cents, pm.method, pm.paid_at, i.invoice_no,
      p.first_name || ' ' || p.last_name AS patient_name
    FROM payments pm
    JOIN invoices i ON i.id = pm.invoice_id
    JOIN patients p ON p.id = i.patient_id
    WHERE pm.clinic_id = ? AND pm.paid_at >= ?::timestamptz AND pm.paid_at < ?::timestamptz
    ORDER BY pm.paid_at
  `, [req.clinic.id, startUtc.toISOString(), endUtc.toISOString()]);

  // issue_date is DATE; compare against UTC instants exactly like the previous
  // datetime(issue_date) >= datetime(?) SQLite comparison (sessions pinned to UTC).
  const invoiced = Number((await db.q1(`
    SELECT COALESCE(SUM(total_cents),0) AS c FROM invoices
    WHERE clinic_id = ? AND (issue_date::timestamp AT TIME ZONE 'UTC') >= ?::timestamptz
      AND (issue_date::timestamp AT TIME ZONE 'UTC') < ?::timestamptz
  `, [req.clinic.id, startUtc.toISOString(), endUtc.toISOString()])).c);

  const collected = payments.reduce((s, p) => s + (p.type === 'payment' ? Number(p.amount_cents) : -Number(p.amount_cents)), 0);
  const outstanding = Number((await db.q1(`
    SELECT COALESCE(SUM(i.total_cents - COALESCE((SELECT SUM(CASE WHEN p.type = 'payment' THEN p.amount_cents ELSE -p.amount_cents END) FROM payments p WHERE p.invoice_id = i.id),0)),0) AS c
    FROM invoices i WHERE i.clinic_id = ? AND i.status != 'paid'
  `, [req.clinic.id])).c);

  if (req.query.format === 'csv') {
    return sendCsv(res, 'revenue-report.csv',
      ['Paid at', 'Invoice', 'Patient', 'Method', 'Type', 'Amount'],
      payments.map((p) => {
        const w = wallParts(new Date(p.paid_at), tz);
        const signed = p.type === 'payment' ? Number(p.amount_cents) : -Number(p.amount_cents);
        return [`${w.date} ${w.time}`, p.invoice_no, p.patient_name, p.method, p.type || 'payment', (signed / 100).toFixed(2)];
      }));
  }

  const byMethod = {};
  for (const p of payments) byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount_cents);
  res.json({ invoiced_cents: invoiced, collected_cents: collected, outstanding_cents: outstanding, by_method: byMethod, payments: payments.slice(0, 500) });
}));

// GET /api/reports/patients?from=&to=&format=csv
router.get('/patients', requireAuth, requireClinic, requireRole('owner', 'receptionist'), asyncH(async (req, res) => {
  const tz = req.clinic.timezone;
  const { startUtc, endUtc } = parseRange(req, tz);
  const where = `clinic_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz`;
  const bounds = [req.clinic.id, startUtc.toISOString(), endUtc.toISOString()];

  if (req.query.format === 'csv') {
    // Full export (file download) — columns already minimal, ordered by registration.
    const rows = await db.q(`
      SELECT mrn, first_name, last_name, dob, gender, phone, created_at FROM patients
      WHERE ${where} ORDER BY created_at
    `, bounds);
    return sendCsv(res, 'new-patients-report.csv',
      ['Registered at', 'MRN', 'First name', 'Last name', 'DOB', 'Gender', 'Phone'],
      rows.map((r) => {
        const w = wallParts(new Date(r.created_at), tz);
        return [`${w.date} ${w.time}`, r.mrn, r.first_name, r.last_name, r.dob, r.gender, r.phone];
      }));
  }
  // JSON view is paginated: a 30-day window can hold thousands of registrations
  // and the browser only ever shows one page at a time.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const total = Number((await db.q1(`SELECT COUNT(*) AS c FROM patients WHERE ${where}`, bounds)).c);
  const rows = await db.q(`
    SELECT id, mrn, first_name, last_name, dob, gender, phone, created_at FROM patients
    WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `, [...bounds, limit, (page - 1) * limit]);
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, patients: rows });
}));

// GET /api/reports/operations?from=&to=&format=csv — real operational metrics:
// no-show rate per doctor, utilization, revenue by service, billed vs collected, aging.
router.get('/operations', requireAuth, requireClinic, requireRole('owner', 'accountant'), asyncH(async (req, res) => {
  const tz = req.clinic.timezone;
  const { startUtc, endUtc } = parseRange(req, tz);
  const sIso = startUtc.toISOString();
  const eIso = endUtc.toISOString();

  const perDoctor = await db.q(`
    SELECT d.id AS doctor_id, d.name AS doctor_name,
      COALESCE(SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END),0)::bigint AS no_shows,
      COALESCE(SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END),0)::bigint AS completed,
      COALESCE(SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END),0)::bigint AS cancelled,
      COUNT(a.id)::bigint AS total,
      COALESCE(SUM(CASE WHEN a.status NOT IN ('cancelled','no_show') THEN a.duration_min ELSE 0 END),0)::bigint AS booked_minutes
    FROM doctors d
    LEFT JOIN appointments a ON a.doctor_id = d.id AND a.clinic_id = d.clinic_id
      AND a.start_at >= ?::timestamptz AND a.start_at < ?::timestamptz
    WHERE d.clinic_id = ?
    GROUP BY d.id ORDER BY d.name
  `, [sIso, eIso, req.clinic.id]);

  // Capacity: working hours in range × per-day minutes (clinic tz approximation per day)
  let hours = {};
  try { hours = JSON.parse(req.clinic.working_hours || '{}'); } catch { /* empty */ }
  let capacityMinutesPerWeek = 0;
  for (const [, w] of Object.entries(hours)) {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    capacityMinutesPerWeek += (eh * 60 + em) - (sh * 60 + sm);
  }
  const days = Math.max(1, Math.round((endUtc - startUtc) / 86400000));
  const activeDoctors = Number((await db.q1('SELECT COUNT(*) AS c FROM doctors WHERE clinic_id = ? AND is_active = 1', [req.clinic.id])).c);
  const weeklyCapacity = capacityMinutesPerWeek * activeDoctors;
  const capacityInRange = Math.round((weeklyCapacity / 7) * days);

  // issue_date is a clinic-wall DATE: compare with plain date bounds so
  // idx_invoices_clinic (clinic_id, issue_date) is usable (no per-row casts).
  const startDate = sIso.slice(0, 10);
  const endDate = eIso.slice(0, 10);

  // Independent aggregates run concurrently (one event-loop round instead of six).
  const [revenueByService, billedRow, collectedRow, aging] = await Promise.all([
    db.q(`
      SELECT COALESCE(s.name, ii.description) AS service, COALESCE(SUM(ii.amount_cents),0)::bigint AS cents, COUNT(ii.id)::bigint AS lines
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN services s ON s.id = ii.service_id
      WHERE ii.clinic_id = ? AND i.issue_date >= ?::date AND i.issue_date <= ?::date
      GROUP BY 1 ORDER BY cents DESC
    `, [req.clinic.id, startDate, endDate]),
    db.q1(`
      SELECT COALESCE(SUM(total_cents),0) AS c FROM invoices
      WHERE clinic_id = ? AND issue_date >= ?::date AND issue_date <= ?::date
    `, [req.clinic.id, startDate, endDate]),
    db.q1(`
      SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END),0) AS c FROM payments
      WHERE clinic_id = ? AND paid_at >= ?::timestamptz AND paid_at < ?::timestamptz
    `, [req.clinic.id, sIso, eIso]),
    // Aging buckets + outstanding total in ONE pass: hash-join payments per
    // unpaid invoice instead of a correlated subquery, no second full scan.
    db.q1(`
      WITH bal AS (
        SELECT i.issue_date,
               (i.total_cents - COALESCE(SUM(CASE WHEN p.type = 'payment' THEN p.amount_cents ELSE -p.amount_cents END), 0))::bigint AS bal
        FROM invoices i
        LEFT JOIN payments p ON p.invoice_id = i.id
        WHERE i.clinic_id = ? AND i.status != 'paid'
        GROUP BY i.id, i.issue_date, i.total_cents
      )
      SELECT
        COALESCE(SUM(bal),0)::bigint AS total_outstanding,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - issue_date) <= 30 THEN bal ELSE 0 END),0)::bigint AS d0_30,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - issue_date) > 30 AND (CURRENT_DATE - issue_date) <= 60 THEN bal ELSE 0 END),0)::bigint AS d31_60,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - issue_date) > 60 AND (CURRENT_DATE - issue_date) <= 90 THEN bal ELSE 0 END),0)::bigint AS d61_90,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - issue_date) > 90 THEN bal ELSE 0 END),0)::bigint AS d90plus
      FROM bal
    `, [req.clinic.id]),
  ]);
  const billed = Number(billedRow.c);
  const collected = Number(collectedRow.c);

  const doctors = perDoctor.map((d) => ({
    doctor_id: d.doctor_id,
    doctor_name: d.doctor_name,
    total: Number(d.total) || 0,
    no_shows: Number(d.no_shows) || 0,
    completed: Number(d.completed) || 0,
    cancelled: Number(d.cancelled) || 0,
    no_show_rate: Number(d.total) ? Number(d.no_shows) / Number(d.total) : 0,
    booked_minutes: Number(d.booked_minutes) || 0,
  }));

  if (req.query.format === 'csv') {
    return sendCsv(res, 'operations-report.csv',
      ['Doctor', 'Appointments', 'Completed', 'No-shows', 'Cancelled', 'No-show rate %', 'Booked minutes'],
      doctors.map((d) => [d.doctor_name, d.total, d.completed, d.no_shows, d.cancelled, (d.no_show_rate * 100).toFixed(1), d.booked_minutes]));
  }

  const outstandingTotal = Number(aging.total_outstanding) || 0;

  res.json({
    range: { days },
    doctors,
    utilization: {
      booked_minutes: doctors.reduce((s, d) => s + d.booked_minutes, 0),
      capacity_minutes: capacityInRange,
      rate: capacityInRange ? doctors.reduce((s, d) => s + d.booked_minutes, 0) / capacityInRange : 0,
    },
    revenue_by_service: revenueByService.map((r) => ({ ...r, cents: Number(r.cents), lines: Number(r.lines) })),
    billed_cents: billed,
    collected_cents: collected,
    outstanding: { total_cents: outstandingTotal, aging: { d0_30: Number(aging.d0_30) || 0, d31_60: Number(aging.d31_60) || 0, d61_90: Number(aging.d61_90) || 0, d90plus: Number(aging.d90plus) || 0 } },
  });
}));

module.exports = router;
