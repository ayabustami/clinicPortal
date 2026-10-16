'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS } = require('../auth');
const { asyncH, badRequest, notFound, conflict } = require('../util/errors');
const V = require('../util/validate');
const { audit, logActivity } = require('../util/audit');
const { nowIso, todayLocalDate, parseIso } = require('../util/time');
const inv = require('../services/invoices');

const METHODS = ['cash', 'card', 'bank_transfer', 'insurance', 'other'];

async function recomputeStatus(t, invoiceId) {
  const row = await t.q1('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  const paid = await inv.paidCents(t, invoiceId);
  const status = paid >= row.total_cents ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  await t.exec('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), invoiceId]);
}

async function fullInvoice(t, clinicId, id) {
  const row = await t.q1(`
    SELECT i.*, p.first_name || ' ' || p.last_name AS patient_name, p.mrn AS patient_mrn,
      u.full_name AS created_by_name, c.currency AS clinic_currency, c.name AS clinic_name,
      c.address AS clinic_address, c.phone AS clinic_phone, c.email AS clinic_email
    FROM invoices i
    JOIN patients p ON p.id = i.patient_id
    JOIN clinics c ON c.id = i.clinic_id
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.id = ? AND i.clinic_id = ?
  `, [id, clinicId]);
  if (!row) return null;
  row.currency = row.currency || row.clinic_currency;
  row.items = await t.q('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [id]);
  row.payments = await t.q(`
    SELECT pm.*, u.full_name AS received_by_name FROM payments pm
    LEFT JOIN users u ON u.id = pm.received_by
    WHERE pm.invoice_id = ? ORDER BY pm.paid_at
  `, [id]);
  // Net of refunds/adjustments; gross kept for display of money received.
  row.gross_paid_cents = row.payments.reduce((s, p) => s + (p.type === 'payment' ? Number(p.amount_cents) : 0), 0);
  row.refunded_cents = row.payments.reduce((s, p) => s + (p.type === 'payment' ? 0 : Number(p.amount_cents)), 0);
  row.paid_cents = row.gross_paid_cents - row.refunded_cents;
  row.balance_cents = Math.max(0, row.total_cents - row.paid_cents);
  return row;
}

/** appointment_id (when provided) must belong to the same clinic AND same patient. */
async function validateAppointmentLink(t, clinicId, appointment_id, patient_id) {
  if (!appointment_id) return null;
  const appt = await t.q1('SELECT * FROM appointments WHERE id = ? AND clinic_id = ?', [appointment_id, clinicId]);
  if (!appt) throw badRequest('Linked appointment not found in this clinic');
  if (appt.patient_id !== patient_id) throw badRequest('Linked appointment belongs to a different patient');
  return appt;
}

// GET /api/invoices?status=&patient_id=&search=&page=&limit=
router.get('/', requireAuth, requireClinic, requireRole(...PERMS.invoice_read), asyncH(async (req, res) => {
  const qs = req.query;
  const where = ['i.clinic_id = ?'];
  const params = [req.clinic.id];
  if (qs.status) {
    const s = V.oneOf(qs.status, 'status', ['unpaid', 'partial', 'paid']);
    where.push('i.status = ?'); params.push(s);
  }
  if (qs.patient_id) { where.push('i.patient_id = ?'); params.push(V.int(qs.patient_id, 'patient_id', { min: 1 })); }
  if (qs.search) {
    where.push('(i.invoice_no LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?)');
    const like = `%${qs.search}%`;
    params.push(like, like, like);
  }
  const page = V.int(qs.page, 'page', { min: 1, def: 1 });
  const limit = V.int(qs.limit, 'limit', { min: 1, max: 100, def: 20 });
  const total = Number((await db.q1(`
    SELECT COUNT(*) AS c FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${where.join(' AND ')}
  `, params)).c);
  const rows = await db.q(`
    SELECT i.id, i.invoice_no, i.patient_id, i.issue_date, i.due_date, i.status, i.total_cents, i.currency,
      p.first_name || ' ' || p.last_name AS patient_name,
      COALESCE((SELECT SUM(pm.amount_cents) FROM payments pm WHERE pm.invoice_id = i.id), 0) AS paid_cents
    FROM invoices i JOIN patients p ON p.id = i.patient_id
    WHERE ${where.join(' AND ')}
    ORDER BY i.id DESC LIMIT ? OFFSET ?
  `, [...params, limit, (page - 1) * limit]);
  res.json({
    invoices: rows.map((i) => ({ ...i, currency: i.currency || req.clinic.currency, paid_cents: Number(i.paid_cents), balance_cents: Math.max(0, i.total_cents - Number(i.paid_cents)) })),
    total, page, pages: Math.max(1, Math.ceil(total / limit)),
  });
}));

// POST /api/invoices
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.invoice_create), asyncH(async (req, res) => {
  const body = req.body || {};
  const patient_id = V.int(body.patient_id, 'patient_id', { required: true, min: 1 });
  const patient = await db.q1('SELECT * FROM patients WHERE id = ? AND clinic_id = ? AND is_active = 1', [patient_id, req.clinic.id]);
  if (!patient) throw badRequest('Select a valid, active patient for this clinic');
  const issue_date = V.isoDate(body.issue_date, 'Issue date') || todayLocalDate(req.clinic.timezone);
  const due_date = body.due_date !== undefined ? V.isoDate(body.due_date, 'Due date') : null;
  const notes = V.str(body.notes, 'Notes', { max: 2000 });
  const itemsIn = V.arrayField(body.items, 'items', { required: true });
  if (!itemsIn.length) throw badRequest('Invoice needs at least one line item');
  const appointment_id = V.int(body.appointment_id, 'appointment_id', { min: 1 }) || null;
  await validateAppointmentLink(db, req.clinic.id, appointment_id, patient_id);

  // Idempotency (Stage K): re-submitting a visit invoice (double click, page
  // refresh, retry) must not mint a second document. If an untouched invoice
  // (unpaid, zero paid, no payments) already exists for this appointment we
  // return it instead of creating a duplicate. Paid/partial invoices are
  // never replayed — a new billable document then remains a deliberate act.
  if (appointment_id) {
    const replay = await db.q1(`
      SELECT i.id FROM invoices i
      WHERE i.clinic_id = ? AND i.appointment_id = ? AND i.status = 'unpaid'
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)
      ORDER BY i.id ASC LIMIT 1
    `, [req.clinic.id, appointment_id]);
    if (replay) {
      return res.json({ invoice: await fullInvoice(db, req.clinic.id, replay.id), idempotent_replay: true });
    }
  }

  const { items, subtotal } = await inv.normalizeItems(db, req.clinic.id, itemsIn);

  const invoiceId = await db.withTx(async (t) => {
    const invoiceNo = await inv.nextInvoiceNo(t, req.clinic.id);
    const created = await t.q1(`
      INSERT INTO invoices (clinic_id, invoice_no, patient_id, appointment_id, issue_date, due_date, notes, subtotal_cents, total_cents, currency, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?) RETURNING id
    `, [req.clinic.id, invoiceNo, patient_id, appointment_id, issue_date, due_date,
      notes, subtotal, subtotal, req.clinic.currency, req.user.id]);
    const newId = created.id;
    for (const it of items) {
      await t.exec(`
        INSERT INTO invoice_items (invoice_id, clinic_id, service_id, description, quantity, unit_price_cents, amount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [newId, req.clinic.id, it.service_id, it.description, it.quantity, it.unit_price_cents, it.amount_cents]);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'invoice.create', entity: 'invoice', entityId: newId,
      details: { patient_id, appointment_id, total_cents: subtotal, items: items.length, currency: req.clinic.currency } });
    return newId;
  });
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'billing',
    message: `Invoice created for ${patient.first_name} ${patient.last_name}` });
  res.status(201).json({ invoice: await fullInvoice(db, req.clinic.id, invoiceId) });
}));

async function getOwnInvoice(t, clinicId, id) {
  const row = await t.q1('SELECT * FROM invoices WHERE id = ? AND clinic_id = ?', [id, clinicId]);
  if (!row) throw notFound('Invoice not found');
  return row;
}

// GET /api/invoices/:id
router.get('/:id', requireAuth, requireClinic, requireRole(...PERMS.invoice_read), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  await getOwnInvoice(db, req.clinic.id, id);
  res.json({ invoice: await fullInvoice(db, req.clinic.id, id) });
}));

/**
 * PUT /api/invoices/:id — update meta and/or replace line items.
 * Paid invoices are final: items, totals and issue date cannot change anymore
 * (notes/due_date remain editable for follow-up communication).
 */
router.put('/:id', requireAuth, requireClinic, requireRole(...PERMS.invoice_create), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const row = await getOwnInvoice(db, req.clinic.id, id);
  const body = req.body || {};
  const editingItems = body.items !== undefined;
  if (row.status === 'paid' && (editingItems || body.issue_date !== undefined)) {
    throw conflict('This invoice is fully paid and final. Item and issue-date changes are blocked; record adjustments on a new invoice.');
  }
  // Price/item edits are locked the moment money is recorded — historical
  // pricing and payment math must stay consistent (clinic policy).
  if (editingItems) {
    const payCount = await db.q1('SELECT COUNT(*)::int AS c FROM payments WHERE invoice_id = ?', [id]);
    if (payCount.c > 0) {
      throw conflict('This invoice already has payments recorded. Prices are locked; use a refund/adjustment or a new invoice.');
    }
  }

  await db.withTx(async (t) => {
    if (body.notes !== undefined || body.due_date !== undefined || body.issue_date !== undefined) {
      await t.exec('UPDATE invoices SET notes = ?, due_date = ?, issue_date = ?, updated_at = ? WHERE id = ?',
        [
          body.notes !== undefined ? V.str(body.notes, 'Notes', { max: 2000 }) : row.notes,
          body.due_date !== undefined ? V.isoDate(body.due_date, 'Due date') : row.due_date,
          body.issue_date !== undefined ? V.isoDate(body.issue_date, 'Issue date', { required: true }) : row.issue_date,
          nowIso(), id,
        ]);
    }
    if (editingItems) {
      const itemsIn = V.arrayField(body.items, 'items');
      if (!itemsIn.length) throw badRequest('Invoice needs at least one line item');
      const { items, subtotal } = await inv.normalizeItems(t, req.clinic.id, itemsIn);
      const paid = await inv.paidCents(t, id);
      if (paid > subtotal) throw badRequest('Cannot reduce the invoice total below the amount already paid');
      const before = await t.q('SELECT id, description, quantity, unit_price_cents FROM invoice_items WHERE invoice_id = ?', [id]);
      await t.exec('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);
      for (const it of items) {
        await t.exec(`
          INSERT INTO invoice_items (invoice_id, clinic_id, service_id, description, quantity, unit_price_cents, amount_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, req.clinic.id, it.service_id, it.description, it.quantity, it.unit_price_cents, it.amount_cents]);
      }
      await t.exec('UPDATE invoices SET subtotal_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?', [subtotal, subtotal, nowIso(), id]);
      await recomputeStatus(t, id);
      await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'invoice.items.update', entity: 'invoice', entityId: id,
        details: { total_before: row.total_cents, total_after: subtotal, items_before: before.length, items_after: items.length } });
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'invoice.update', entity: 'invoice', entityId: id });
  });
  res.json({ invoice: await fullInvoice(db, req.clinic.id, id) });
}));

// POST /api/invoices/:id/payments
router.post('/:id/payments', requireAuth, requireClinic, requireRole(...PERMS.financial), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const row = await getOwnInvoice(db, req.clinic.id, id);
  const body = req.body || {};
  const amount_cents = V.moneyCents(body.amount, 'Amount', { required: true });
  if (amount_cents <= 0) throw badRequest('Payment amount must be greater than zero');
  const method = V.oneOf(body.method, 'Payment method', METHODS, { def: 'cash' });
  const reference = V.str(body.reference, 'Reference', { max: 120 });
  const paid_at = body.paid_at ? (parseIso(body.paid_at) || new Date()).toISOString() : nowIso();
  // 'payment' adds money; 'refund' and 'adjustment' subtract it (credit notes,
  // corrections). All three are real, audited payment rows.
  const type = V.oneOf(body.type, 'type', ['payment', 'refund', 'adjustment']) || 'payment';
  const idempotencyKey = V.str(body.idempotency_key, 'idempotency_key', { max: 120 });

  // Idempotency: a retried request with the same key returns the original row.
  if (idempotencyKey) {
    const dup = await db.q1('SELECT id FROM payments WHERE clinic_id = ? AND idempotency_key = ?', [req.clinic.id, idempotencyKey]);
    if (dup) {
      return res.status(200).json({ invoice: await fullInvoice(db, req.clinic.id, id), idempotent: true, payment_id: dup.id });
    }
  }

  const netPaid = await inv.paidCents(db, id); // net of refunds/adjustments
  if (type === 'payment') {
    const balance = row.total_cents - netPaid;
    if (amount_cents > balance) {
      throw badRequest(`Payment exceeds the outstanding balance of ${(balance / 100).toFixed(2)} ${row.currency || req.clinic.currency}`);
    }
  } else {
    // Refunds/adjustments may never push the invoice into negative-net territory.
    if (amount_cents > netPaid) {
      throw badRequest(`Refund exceeds the net amount paid on this invoice (${(netPaid / 100).toFixed(2)} ${row.currency || req.clinic.currency})`);
    }
  }

  await db.withTx(async (t) => {
    // Re-check inside the transaction (concurrent payments on the same invoice).
    await t.q1('SELECT pg_advisory_xact_lock(?) AS locked', [id]);
    const netInside = Number((await t.q1(
      `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END),0) AS c FROM payments WHERE invoice_id = ?`, [id])).c);
    if (type === 'payment' && amount_cents > row.total_cents - netInside) {
      throw badRequest('Payment exceeds the outstanding balance (concurrent payment detected)');
    }
    if (type !== 'payment' && amount_cents > netInside) {
      throw badRequest('Refund exceeds the net amount paid (concurrent change detected)');
    }
    const created = await t.q1(`
      INSERT INTO payments (invoice_id, clinic_id, amount_cents, method, reference, paid_at, received_by, type, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [id, req.clinic.id, amount_cents, method, reference, paid_at, req.user.id, type, idempotencyKey || null]);
    await recomputeStatus(t, id);
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id,
      action: type === 'payment' ? 'payment.record' : `payment.${type}`, entity: 'invoice', entityId: id,
      details: { amount_cents, method, type, payment_id: created.id, reference: reference || null } });
  });
  const patient = await db.q1('SELECT first_name, last_name FROM patients WHERE id = ?', [row.patient_id]);
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'billing',
    message: `${type === 'payment' ? 'Payment' : type === 'refund' ? 'Refund' : 'Adjustment'} recorded on ${row.invoice_no} (${patient.first_name} ${patient.last_name})` });
  res.status(201).json({ invoice: await fullInvoice(db, req.clinic.id, id) });
}));

module.exports = router;
