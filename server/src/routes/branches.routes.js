'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const { asyncH, badRequest, notFound } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');

router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const branches = await db.q('SELECT * FROM branches WHERE clinic_id = ? ORDER BY name', [req.clinic.id]);
  res.json({ branches });
}));

router.post('/', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const body = req.body || {};
  const name = V.str(body.name, 'Branch name', { required: true, max: 120 });
  const address = V.str(body.address, 'Address', { max: 200 });
  const created = await db.q1('INSERT INTO branches (clinic_id, name, address) VALUES (?, ?, ?) RETURNING *',
    [req.clinic.id, name, address]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'branch.create', entity: 'branch', entityId: created.id });
  res.status(201).json({ branch: created });
}));

router.put('/:id', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const branch = await db.q1('SELECT * FROM branches WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  if (!branch) throw notFound('Branch not found');
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) updates.name = V.str(body.name, 'Branch name', { required: true, max: 120 });
  if (body.address !== undefined) updates.address = V.str(body.address, 'Address', { max: 200 });
  if (body.is_active !== undefined) updates.is_active = V.bool(body.is_active) ? 1 : 0;
  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');
  const updated = await db.q1(
    `UPDATE branches SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND clinic_id = ? RETURNING *`,
    [...fields.map((f) => updates[f]), id, req.clinic.id]
  );
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'branch.update', entity: 'branch', entityId: id });
  res.json({ branch: updated });
}));

module.exports = router;
