'use strict';
const router = require('express').Router();
const { q } = require('../db');
const { requireAuth, requireClinic } = require('../auth');
const { asyncH } = require('../util/errors');
const V = require('../util/validate');

// GET /api/activity?limit=
router.get('/', requireAuth, requireClinic, asyncH(async (req, res) => {
  const limit = V.int(req.query.limit, 'limit', { min: 1, max: 100, def: 30 });
  const items = await q(`
    SELECT a.kind, a.message, a.created_at, u.full_name AS user_name
    FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.clinic_id = ? ORDER BY a.id DESC LIMIT ?
  `, [req.clinic.id, limit]);
  res.json({ activity: items });
}));

module.exports = router;
