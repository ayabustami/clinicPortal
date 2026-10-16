'use strict';
/**
 * Invoice domain logic shared by create and update routes:
 * item normalization/validation and clinic-safe invoice numbering.
 * Async: every function takes a db runner `t` (pool helpers or transaction).
 */
const { badRequest } = require('../util/errors');
const V = require('../util/validate');

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Validate and normalize invoice line items.
 * Every referenced service must belong to the same clinic. Descriptions and
 * prices from the payload win over service defaults (services may change later;
 * invoice lines are historical snapshots).
 */
async function normalizeItems(t, clinicId, itemsIn) {
  const items = [];
  for (let idx = 0; idx < itemsIn.length; idx++) {
    const it = itemsIn[idx];
    let description = V.str(it.description, `Item ${idx + 1} description`, { max: 200 });
    let unit_price_cents = null;
    if (it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== '') {
      if (typeof it.unit_price === 'string' && !MONEY_RE.test(it.unit_price.trim())) {
        throw badRequest(`Item ${idx + 1} price must be a positive amount with up to 2 decimals`);
      }
      unit_price_cents = V.moneyCents(it.unit_price, `Item ${idx + 1} price`, { required: true });
    }
    const quantity = V.int(it.quantity, `Item ${idx + 1} quantity`, { min: 1, max: 1000, def: 1 });
    const service_id = V.int(it.service_id, `Item ${idx + 1} service`, { min: 1 }) || null;
    if (service_id) {
      const svcRow = await t.q1('SELECT * FROM services WHERE id = ? AND clinic_id = ?', [service_id, clinicId]);
      if (!svcRow) throw badRequest(`Item ${idx + 1}: service not found in this clinic`);
      if (!description) description = svcRow.name;
      if (unit_price_cents === null) unit_price_cents = svcRow.price_cents;
    }
    if (!description) throw badRequest(`Item ${idx + 1} needs a description`);
    if (unit_price_cents === null) throw badRequest(`Item ${idx + 1} needs a unit price`);
    items.push({ service_id, description, quantity, unit_price_cents, amount_cents: unit_price_cents * quantity });
  }
  const subtotal = items.reduce((s, it) => s + it.amount_cents, 0);
  return { items, subtotal };
}

/**
 * Concurrency-safe invoice number: max existing suffix for the year + 1.
 * (COUNT(*)+1 breaks when numbers are consumed non-linearly.) Existing numbers
 * are never reused or renumbered.
 */
async function nextInvoiceNo(t, clinicId) {
  const year = new Date().getUTCFullYear();
  const prefix = `INV-${year}-`;
  const row = await t.q1(`
    SELECT invoice_no FROM invoices
    WHERE clinic_id = ? AND invoice_no LIKE ?
    ORDER BY invoice_no DESC LIMIT 1
  `, [clinicId, `${prefix}%`]);
  let n = 0;
  if (row) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(row.invoice_no);
    if (m) n = parseInt(m[1], 10);
  }
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
}

async function paidCents(t, invoiceId) {
  // Net of refunds/adjustments: payments add, refunds & adjustments subtract.
  const row = await t.q1(`SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount_cents ELSE -amount_cents END),0) AS c FROM payments WHERE invoice_id = ?`, [invoiceId]);
  return Number(row.c);
}

module.exports = { normalizeItems, nextInvoiceNo, paidCents };
