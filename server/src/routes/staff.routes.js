'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireClinic, requireRole, hashPassword, publicUser } = require('../auth');
const A = require('../auth');
const { asyncH, badRequest, notFound, conflict } = require('../util/errors');
const V = require('../util/validate');
const { audit, logActivity } = require('../util/audit');

const ROLES = ['owner', 'receptionist', 'doctor', 'accountant'];
const DOCTOR_COLORS = ['#0d8f7e', '#2563eb', '#7c3aed', '#d97706', '#db2777', '#4d7c0f', '#0891b2'];

// ---------- Doctors ----------

router.get('/doctors', requireAuth, requireClinic, asyncH(async (req, res) => {
  const rows = await db.q(`
    SELECT d.*, u.email AS user_email,
      (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = d.id) AS appointment_count
    FROM doctors d LEFT JOIN users u ON u.id = d.user_id
    WHERE d.clinic_id = ? ORDER BY d.name
  `, [req.clinic.id]);
  res.json({ doctors: rows.map((d) => ({ ...d, is_active: !!d.is_active, appointment_count: Number(d.appointment_count) })) });
}));

router.post('/doctors', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const body = req.body || {};
  const name = V.str(body.name, 'Doctor name', { required: true, max: 120 });
  const specialty = V.str(body.specialty, 'Specialty', { max: 120 });
  const color = V.str(body.color, 'Color', { max: 9 }) || DOCTOR_COLORS[Math.floor(Math.random() * DOCTOR_COLORS.length)];
  const created = await db.q1('INSERT INTO doctors (clinic_id, name, specialty, color) VALUES (?, ?, ?, ?) RETURNING *',
    [req.clinic.id, name, specialty, color]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'doctor.create', entity: 'doctor', entityId: created.id });
  await logActivity(db, { clinicId: req.clinic.id, userId: req.user.id, kind: 'staff', message: `Added doctor ${name}` });
  res.status(201).json({ doctor: created });
}));

router.put('/doctors/:id', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const doctor = await db.q1('SELECT * FROM doctors WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  if (!doctor) throw notFound('Doctor not found');
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) updates.name = V.str(body.name, 'Doctor name', { required: true, max: 120 });
  if (body.specialty !== undefined) updates.specialty = V.str(body.specialty, 'Specialty', { max: 120 });
  if (body.color !== undefined) updates.color = V.str(body.color, 'Color', { max: 9 });
  if (body.is_active !== undefined) updates.is_active = V.bool(body.is_active) ? 1 : 0;
  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');
  const updated = await db.q1(
    `UPDATE doctors SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND clinic_id = ? RETURNING *`,
    [...fields.map((f) => updates[f]), id, req.clinic.id]
  );
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'doctor.update', entity: 'doctor', entityId: id });
  res.json({ doctor: updated });
}));

// ---------- Users / employees ----------

router.get('/users', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const users = await db.q('SELECT * FROM users WHERE clinic_id = ? ORDER BY full_name', [req.clinic.id]);
  res.json({ users: users.map(publicUser) });
}));

router.post('/users', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const body = req.body || {};
  const full_name = V.str(body.full_name, 'Full name', { required: true, max: 120 });
  const email = V.email(body.email, 'Email', { required: true });
  const password = V.str(body.password, 'Password', { required: true, max: 200 });
  if (password.length < 8) throw badRequest('Password must be at least 8 characters');
  const role = V.oneOf(body.role, 'Role', ROLES, { required: true });
  const phone = V.str(body.phone, 'Phone', { max: 40 });

  // lower() preserves the previous case-insensitive uniqueness behavior
  const taken = await db.q1('SELECT id FROM users WHERE lower(email) = lower(?)', [email]);
  if (taken) throw conflict('A user with this email already exists');

  const userId = await db.withTx(async (t) => {
    const created = await t.q1(`
      INSERT INTO users (clinic_id, email, password_hash, full_name, role, phone) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [req.clinic.id, email, hashPassword(password), full_name, role, phone]);
    const newId = created.id;
    // If the new user is a doctor, link/create a doctor profile automatically.
    if (role === 'doctor') {
      const existing = await t.q1('SELECT id FROM doctors WHERE clinic_id = ? AND user_id = ?', [req.clinic.id, newId]);
      if (!existing) {
        await t.exec('INSERT INTO doctors (clinic_id, user_id, name, specialty) VALUES (?, ?, ?, ?)',
          [req.clinic.id, newId, full_name, V.str(body.specialty, 'Specialty', { max: 120 }) || null]);
      }
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'user.create', entity: 'user', entityId: newId, details: { email, role } });
    await logActivity(t, { clinicId: req.clinic.id, userId: req.user.id, kind: 'staff', message: `Added staff member ${full_name} (${role})` });
    return newId;
  });
  const user = await db.q1('SELECT * FROM users WHERE id = ?', [userId]);
  res.status(201).json({ user: publicUser(user) });
}));

router.put('/users/:id', requireAuth, requireClinic, requireRole('owner'), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const target = await db.q1('SELECT * FROM users WHERE id = ? AND clinic_id = ?', [id, req.clinic.id]);
  if (!target) throw notFound('User not found');
  const body = req.body || {};
  const updates = {};
  if (body.full_name !== undefined) updates.full_name = V.str(body.full_name, 'Full name', { required: true, max: 120 });
  if (body.role !== undefined) updates.role = V.oneOf(body.role, 'Role', ROLES, { required: true });
  if (body.phone !== undefined) updates.phone = V.str(body.phone, 'Phone', { max: 40 });
  if (body.is_active !== undefined) {
    if (id === req.user.id) throw badRequest('You cannot deactivate your own account');
    updates.is_active = V.bool(body.is_active) ? 1 : 0;
  }
  if (body.password !== undefined) {
    const password = V.str(body.password, 'Password', { required: true, max: 200 });
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    updates.password_hash = hashPassword(password);
  }
  const fields = Object.keys(updates);
  if (!fields.length) throw badRequest('No fields to update');

  // --- Last-owner protection (server-enforced) ---
  const losesOwnership = target.role === 'owner' && (
    (updates.role !== undefined && updates.role !== 'owner') ||
    (updates.is_active !== undefined && updates.is_active === 0)
  );
  if (losesOwnership) {
    const otherOwners = Number((await db.q1(`
      SELECT COUNT(*) AS c FROM users
      WHERE clinic_id = ? AND role = 'owner' AND is_active = 1 AND id != ?
    `, [req.clinic.id, id])).c);
    if (otherOwners === 0) {
      throw badRequest('This is the last active owner of the clinic. Promote or create another owner first.');
    }
  }
  if (id === req.user.id && updates.role !== undefined && updates.role !== 'owner') {
    throw badRequest('You cannot change your own owner role');
  }

  await db.withTx(async (t) => {
    await t.exec(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND clinic_id = ?`,
      [...fields.map((f) => updates[f]), id, req.clinic.id]);
    // Revoke live sessions when the account is disabled, demoted, or password reset by admin.
    if ((updates.is_active === 0) || (updates.password_hash !== undefined) || losesOwnership) {
      await A.bumpTokenVersion(t, id);
    }
    await audit(t, { clinicId: req.clinic.id, userId: req.user.id, action: 'user.update', entity: 'user', entityId: id,
      details: { fields: fields.filter((f) => f !== 'password_hash'), role_before: target.role, role_after: updates.role } });
  });
  const updated = await db.q1('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ user: publicUser(updated) });
}));

module.exports = router;
