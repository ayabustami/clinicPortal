'use strict';
const router = require('express').Router();
const { q, q1 } = require('../db');
const { requireAuth, PERMS } = require('../auth');
const { asyncH, badRequest, forbidden } = require('../util/errors');
const V = require('../util/validate');
const { parseIso } = require('../util/time');

/**
 * Audit trail retrieval.
 * - Clinic owners see their clinic's trail.
 * - Platform admins may inspect a specific clinic via ?clinic_id=.
 * Audit rows are append-only: no update/delete endpoints exist anywhere.
 */
router.get('/', requireAuth, asyncH(async (req, res) => {
  const qs = req.query;
  let clinicId;
  if (req.user.role === 'platform_admin') {
    clinicId = V.int(qs.clinic_id, 'clinic_id', { required: true, min: 1 });
    const clinic = await q1('SELECT id FROM clinics WHERE id = ?', [clinicId]);
    if (!clinic) throw badRequest('Unknown clinic');
  } else {
    if (!PERMS.audit_view.includes(req.user.role)) throw forbidden();
    if (!req.user.clinic_id) throw forbidden('Platform admins must pass clinic_id');
    clinicId = req.user.clinic_id;
  }

  const where = ['a.clinic_id = ?'];
  const params = [clinicId];
  if (qs.action) { where.push('a.action LIKE ?'); params.push(`${V.str(qs.action, 'action', { max: 80 })}%`); }
  if (qs.entity) { where.push('a.entity = ?'); params.push(V.oneOf(qs.entity, 'entity', ['user', 'patient', 'appointment', 'medical_record', 'invoice', 'doctor', 'service', 'branch', 'clinic', 'attachment', 'dental_finding', 'dental_treatment', 'dental_chart'])); }
  if (qs.user_id) { where.push('a.user_id = ?'); params.push(V.int(qs.user_id, 'user_id', { min: 1 })); }
  const from = parseIso(qs.from); const to = parseIso(qs.to);
  if (from) { where.push('a.created_at >= ?::timestamptz'); params.push(from.toISOString()); }
  if (to) { where.push('a.created_at <= ?::timestamptz'); params.push(to.toISOString()); }

  const page = V.int(qs.page, 'page', { min: 1, def: 1 });
  const limit = V.int(qs.limit, 'limit', { min: 1, max: 100, def: 25 });
  const total = Number((await q1(`SELECT COUNT(*) AS c FROM audit_logs a WHERE ${where.join(' AND ')}`, params)).c);
  const rows = await q(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at,
      u.full_name AS actor_name, u.email AS actor_email
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.id DESC LIMIT ? OFFSET ?
  `, [...params, limit, (page - 1) * limit]);
  const items = rows.map((r) => ({ ...r, details: r.details ? safeParse(r.details) : null }));
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = router;
