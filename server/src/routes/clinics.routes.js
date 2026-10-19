'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole } = require('../auth');
const { asyncH, badRequest, notFound, forbidden } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');

const DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];

function validateWorkingHours(input, field = 'working_hours') {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw badRequest(`${field} must be an object keyed by weekday (0=Sunday)`);
  }
  const out = {};
  for (const key of Object.keys(input)) {
    if (!DAY_KEYS.includes(key)) throw badRequest(`${field} keys must be weekdays 0-6`);
    const w = input[key];
    if (w === null || w === '') { continue; } // closed that day
    if (!w || typeof w !== 'object') throw badRequest(`${field}[${key}] must be {start,end} or null`);
    const start = V.str(w.start, `${field}[${key}].start`, { required: true, max: 5 });
    const end = V.str(w.end, `${field}[${key}].end`, { required: true, max: 5 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
      throw badRequest(`${field}[${key}] times must use HH:MM (24h)`);
    }
    if (start >= end) throw badRequest(`${field}[${key}]: start must be before end`);
    out[key] = { start, end };
  }
  return out;
}

// ---- Clinic settings (owner) ----

router.get('/settings', requireAuth, requireClinic, requireRole('owner'), (req, res) => {
  const c = req.clinic;
  res.json({
    clinic: {
      id: c.id, name: c.name, slug: c.slug, email: c.email, phone: c.phone, address: c.address,
      timezone: c.timezone, slot_minutes: c.slot_minutes, currency: c.currency,
      working_hours: (() => { try { return JSON.parse(c.working_hours || '{}'); } catch { return {}; } })(),
    },
  });
});

router.put('/settings', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) updates.name = V.str(body.name, 'Clinic name', { required: true, max: 120 });
  if (body.email !== undefined) updates.email = V.email(body.email, 'Email');
  if (body.phone !== undefined) updates.phone = V.str(body.phone, 'Phone', { max: 40 });
  if (body.address !== undefined) updates.address = V.str(body.address, 'Address', { max: 200 });
  if (body.slot_minutes !== undefined) updates.slot_minutes = V.int(body.slot_minutes, 'Slot length', { min: 15, max: 120 });
  if (body.currency !== undefined) updates.currency = validateCurrency(body.currency);
  if (body.timezone !== undefined) {
    const tz = V.str(body.timezone, 'Timezone', { required: true, max: 64 });
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
    catch { throw badRequest('Timezone must be a valid IANA zone, e.g. Asia/Hebron'); }
    updates.timezone = tz;
  }
  const hours = validateWorkingHours(body.working_hours);
  if (hours !== undefined) updates.working_hours = JSON.stringify(hours);

  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');
  await db.exec(`UPDATE clinics SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
    [...fields.map((f) => updates[f]), req.clinic.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'clinic.settings.update', entity: 'clinic', entityId: req.clinic.id, details: { fields } });
  const c = await db.q1('SELECT * FROM clinics WHERE id = ?', [req.clinic.id]);
  res.json({ ok: true, clinic: {
    id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address,
    timezone: c.timezone, slot_minutes: c.slot_minutes, currency: c.currency || 'ILS',
    working_hours: (() => { try { return JSON.parse(c.working_hours || '{}'); } catch { return {}; } })(),
  } });
}));

// ---- Platform admin: clinic management ----

function assertPlatformAdmin(req) {
  if (req.user.role !== 'platform_admin') throw forbidden('Only platform administrators can manage clinics');
}

router.get('/', requireAuth, asyncH(async (req, res) => {
  assertPlatformAdmin(req);
  const clinics = await db.q(`
    SELECT c.id, c.name, c.slug, c.email, c.phone, c.address, c.timezone, c.status, c.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.clinic_id = c.id)::int AS user_count,
      (SELECT COUNT(*) FROM patients p WHERE p.clinic_id = c.id)::int AS patient_count
    FROM clinics c ORDER BY c.name
  `);
  res.json({ clinics });
}));

router.post('/', requireAuth, asyncH(async (req, res) => {
  assertPlatformAdmin(req);
  const body = req.body || {};
  const name = V.str(body.name, 'Clinic name', { required: true, max: 120 });
  const slug = V.str(body.slug, 'Slug', { max: 60 }) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const email = V.email(body.email, 'Email');
  const phone = V.str(body.phone, 'Phone', { max: 40 });
  const address = V.str(body.address, 'Address', { max: 200 });
  const timezone = V.str(body.timezone, 'Timezone', { max: 64 }) || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw badRequest('Timezone must be a valid IANA zone'); }
  const currency = validateCurrency(body.currency);
  const slot_minutes = V.int(body.slot_minutes, 'Slot length', { min: 15, max: 120, def: 30 });
  // Default working week is Sunday–Thursday 08:00–17:00 (matches deployment market);
  // platform admin may pass an explicit working_hours object instead.
  const workingHours = body.working_hours !== undefined
    ? validateWorkingHours(body.working_hours)
    : {
      '0': { start: '08:00', end: '17:00' }, '1': { start: '08:00', end: '17:00' },
      '2': { start: '08:00', end: '17:00' }, '3': { start: '08:00', end: '17:00' },
      '4': { start: '08:00', end: '17:00' },
    };

  if (await db.q1('SELECT id FROM clinics WHERE slug = ?', [slug])) throw badRequest('Slug already in use');

  const created = await db.q1(`
    INSERT INTO clinics (name, slug, email, phone, address, timezone, slot_minutes, currency, working_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `, [name, slug, email, phone, address, timezone, slot_minutes, currency, JSON.stringify(workingHours)]);
  await audit(db, { userId: req.user.id, action: 'clinic.create', entity: 'clinic', entityId: created.id });
  res.status(201).json({ clinic: created });
}));

/** ISO-4217-like currency code validation. */
function validateCurrency(value, { def = 'ILS' } = {}) {
  if (value === undefined || value === null || value === '') return def;
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw badRequest('Currency must be a 3-letter ISO code (e.g. ILS, JOD, USD)');
  return code;
}

/**
 * POST /api/clinics/:id/owner — platform admin provisions a clinic owner.
 * This is the authorized first-owner flow for newly created clinics (and a
 * recovery path if a clinic somehow lost all active owners).
 */
router.post('/:id/owner', requireAuth, asyncH(async (req, res) => {
  assertPlatformAdmin(req);
  const id = V.int(req.params.id, 'id', { required: true });
  const clinic = await db.q1('SELECT * FROM clinics WHERE id = ?', [id]);
  if (!clinic) throw notFound('Clinic not found');
  const body = req.body || {};
  const full_name = V.str(body.full_name, 'Full name', { required: true, max: 120 });
  const email = V.email(body.email, 'Email', { required: true });
  const password = V.str(body.password, 'Password', { required: true, max: 200 });
  if (password.length < 8) throw badRequest('Password must be at least 8 characters');
  const phone = V.str(body.phone, 'Phone', { max: 40 });
  if (await db.q1('SELECT id FROM users WHERE lower(email) = lower(?)', [email])) throw badRequest('A user with this email already exists');

  const created = await db.q1(`
    INSERT INTO users (clinic_id, email, password_hash, full_name, role, phone) VALUES (?, ?, ?, ?, 'owner', ?)
    RETURNING *
  `, [id, email, require('../auth').hashPassword(password), full_name, phone]);
  await audit(db, { clinicId: id, userId: req.user.id, action: 'clinic.owner.provision', entity: 'user', entityId: created.id, details: { email } });

  // Account-setup invitation email (same flow as staff creation).
  let invite = { sent: false };
  try {
    const { issueCode, exposeDevCode } = require('../util/codes');
    const { sendVerificationEmail } = require('../services/email');
    const { code } = await issueCode(db, { userId: created.id, email, purpose: 'account_setup' });
    invite.sent = await sendVerificationEmail({
      to: email, code, purpose: 'account_setup', name: full_name, clinicName: clinic.name,
    });
    if (exposeDevCode()) invite.dev_code = code;
  } catch (err) {
    console.error('[clinics] account-setup invite failed:', err.message);
  }

  res.status(201).json({ user: require('../auth').publicUser(created), invite });
}));

router.put('/:id', requireAuth, asyncH(async (req, res) => {
  assertPlatformAdmin(req);
  const id = V.int(req.params.id, 'id', { required: true });
  const clinic = await db.q1('SELECT * FROM clinics WHERE id = ?', [id]);
  if (!clinic) throw notFound('Clinic not found');
  const body = req.body || {};
  const updates = {};
  if (body.status !== undefined) updates.status = V.oneOf(body.status, 'status', ['active', 'suspended'], { required: true });
  if (body.name !== undefined) updates.name = V.str(body.name, 'Clinic name', { required: true, max: 120 });
  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');
  const updated = await db.q1(`UPDATE clinics SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? RETURNING *`,
    [...fields.map((f) => updates[f]), id]);
  await audit(db, { userId: req.user.id, action: 'clinic.update', entity: 'clinic', entityId: id });
  res.json({ clinic: updated });
}));

module.exports = router;
