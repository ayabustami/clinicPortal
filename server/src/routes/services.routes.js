'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const { asyncH, badRequest, notFound } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');

const FLAG_FIELDS = ['requires_encounter', 'requires_chart', 'requires_plan_item', 'requires_performed', 'requires_imaging', 'requires_followup', 'bills_item'];

function serializeService(s) {
  const out = { ...s, is_active: !!s.is_active };
  for (const f of FLAG_FIELDS) out[f] = !!s[f];
  return out;
}

router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const services = await db.q('SELECT * FROM services WHERE clinic_id = ? ORDER BY category NULLS LAST, name', [req.clinic.id]);
  res.json({ services: services.map(serializeService) });
}));

router.post('/', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const body = req.body || {};
  const name = V.str(body.name, 'Service name', { required: true, max: 120 });
  const description = V.str(body.description, 'Description', { max: 500 });
  const duration_min = V.int(body.duration_min, 'Duration', { min: 5, max: 480, def: 30 });
  const price_cents = V.moneyCents(body.price, 'Price', { required: true });
  const cfg = readServiceConfig(body);
  const created = await db.q1(
    `INSERT INTO services (clinic_id, name, description, duration_min, price_cents, category, preparation, provider_qualification,
       requires_encounter, requires_chart, requires_plan_item, requires_performed, requires_imaging, requires_followup, bills_item)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [req.clinic.id, name, description, duration_min, price_cents, cfg.category, cfg.preparation, cfg.provider_qualification,
      cfg.requires_encounter, cfg.requires_chart, cfg.requires_plan_item, cfg.requires_performed, cfg.requires_imaging, cfg.requires_followup, cfg.bills_item]
  );
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'service.create', entity: 'service', entityId: created.id });
  res.status(201).json({ service: created });
}));

router.put('/:id', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const svc = await db.q1('SELECT * FROM services WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  if (!svc) throw notFound('Service not found');
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) updates.name = V.str(body.name, 'Service name', { required: true, max: 120 });
  if (body.description !== undefined) updates.description = V.str(body.description, 'Description', { max: 500 });
  if (body.duration_min !== undefined) updates.duration_min = V.int(body.duration_min, 'Duration', { min: 5, max: 480, required: true });
  if (body.price !== undefined) updates.price_cents = V.moneyCents(body.price, 'Price', { required: true });
  if (body.is_active !== undefined) updates.is_active = V.bool(body.is_active) ? 1 : 0;
  Object.assign(updates, readServiceConfig(body, { partial: true }));
  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');
  const updated = await db.q1(
    `UPDATE services SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND clinic_id = ? RETURNING *`,
    [...fields.map((f) => updates[f]), id, req.clinic.id]
  );
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'service.update', entity: 'service', entityId: id });
  res.json({ service: serializeService(updated) });
}));

/** Validated service workflow configuration. Flags default on create, and are
 *  only touched on update when present in the payload. */
function readServiceConfig(body, { partial = false } = {}) {
  const out = {};
  const text = (key, max) => {
    if (body[key] === undefined) return partial ? undefined : null;
    const v = V.str(body[key], key, { max });
    out[key] = v === '' ? null : v;
    return out[key];
  };
  text('category', 60);
  text('preparation', 500);
  text('provider_qualification', 120);
  for (const f of FLAG_FIELDS) {
    if (body[f] === undefined) { if (!partial) out[f] = f === 'requires_encounter' || f === 'bills_item' ? 1 : 0; continue; }
    out[f] = V.bool(body[f]) ? 1 : 0;
  }
  return out;
}

module.exports = router;
