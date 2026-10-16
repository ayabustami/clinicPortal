'use strict';
const router = require('express').Router();
const { q, q1 } = require('../db');
const { requireAuth, publicUser } = require('../auth');
const { asyncH } = require('../util/errors');

function workingHoursObj(clinic) {
  try { return JSON.parse(clinic.working_hours || '{}'); } catch { return {}; }
}

// GET /api/meta/bootstrap — everything the SPA needs to render after login.
router.get('/bootstrap', requireAuth, asyncH(async (req, res) => {
  const payload = { user: publicUser(req.user) };

  if (req.user.role === 'platform_admin') {
    payload.clinics = await q('SELECT id, name, slug, status, timezone FROM clinics ORDER BY name');
    return res.json(payload);
  }

  const clinic = req.clinic;
  payload.clinic = {
    id: clinic.id,
    name: clinic.name,
    slug: clinic.slug,
    email: clinic.email,
    phone: clinic.phone,
    address: clinic.address,
    timezone: clinic.timezone,
    slot_minutes: clinic.slot_minutes,
    currency: clinic.currency || 'ILS',
    working_hours: workingHoursObj(clinic),
  };
  payload.doctors = (await q(
    'SELECT id, name, specialty, color, is_active FROM doctors WHERE clinic_id = ? ORDER BY name',
    [clinic.id]
  )).map((d) => ({ ...d, is_active: !!d.is_active }));
  // Doctors get their linked doctor profile so "My Day" and ownership checks work client-side.
  if (req.user.role === 'doctor') {
    payload.doctor_profile = await q1(
      'SELECT id, name, specialty, color FROM doctors WHERE user_id = ? AND clinic_id = ?',
      [req.user.id, clinic.id]
    ) || null;
  }
  payload.services = await q(
    'SELECT id, name, duration_min, price_cents, is_active FROM services WHERE clinic_id = ? AND is_active = 1 ORDER BY name',
    [clinic.id]
  );
  // All branches with their active flag: booking UIs filter to active ones,
  // Clinic Settings needs the full list to reactivate a branch.
  payload.branches = (await q(
    'SELECT id, name, address, is_active FROM branches WHERE clinic_id = ? ORDER BY is_active DESC, name',
    [clinic.id]
  )).map((b) => ({ ...b, is_active: !!b.is_active }));
  res.json(payload);
}));

module.exports = router;
