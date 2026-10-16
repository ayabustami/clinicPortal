'use strict';
/**
 * Resolve a patient reference from a URL param: numeric id (preferred) or MRN
 * (printed lists, bookmarks). Keeps numeric validation strict for everything
 * else — garbage still produces a clean 400 with a field error.
 */
const { badRequest } = require('./errors');

async function resolvePatientId(db, clinicId, raw) {
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 1) throw badRequest('id must be a whole number', { id: 'invalid' });
    return n;
  }
  if (/^[A-Za-z0-9-]{2,20}$/.test(s)) {
    const row = await db.q1('SELECT id FROM patients WHERE clinic_id = ? AND UPPER(mrn) = UPPER(?)', [clinicId, s]);
    if (row) return row.id;
  }
  throw badRequest('id must be a whole number or an existing MRN', { id: 'invalid' });
}

module.exports = { resolvePatientId };
