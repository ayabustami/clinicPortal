'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const router = require('express').Router();
const config = require('../config');
const storage = require('../storage');
const db = require('../db');
const { requireAuth, requireClinic, requireRole, PERMS, randomId } = require('../auth');
const { asyncH, badRequest, notFound, forbidden } = require('../util/errors');
const V = require('../util/validate');
const { audit } = require('../util/audit');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 }, // %PDF
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: 'webp', magic: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
};

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } });
    } catch (e) {
      return reject(badRequest('Expected a multipart/form-data upload'));
    }
    const fields = {};
    let file = null;
    let sizeLimited = false;
    bb.on('field', (name, val) => { fields[name] = String(val).slice(0, 500); });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      file = { originalName: (info.filename || 'file').slice(0, 250), mimeType: info.mimeType, chunks };
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { sizeLimited = true; });
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (sizeLimited) return reject(badRequest(`File exceeds the ${MAX_BYTES / 1024 / 1024} MB limit`));
      resolve({ fields, file });
    });
    req.pipe(bb);
  });
}

async function getOwnAttachment(clinicId, id) {
  const row = await db.q1('SELECT * FROM attachments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [id, clinicId]);
  if (!row) throw notFound('Attachment not found');
  return row;
}

async function assertEntityAccess(req, entityType, entityId) {
  // Currently only medical_record entities; clinical roles only.
  if (entityType !== 'medical_record') throw badRequest('Unsupported attachment entity type');
  const record = await db.q1('SELECT * FROM medical_records WHERE id = ? AND clinic_id = ?', [entityId, req.clinic.id]);
  if (!record) throw notFound('Medical record not found in this clinic');
  return record;
}

// POST /api/attachments  (multipart: entity_type, entity_id, file)
router.post('/', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const { fields, file } = await parseMultipart(req);
  const entity_type = V.oneOf(fields.entity_type, 'entity_type', ['medical_record'], { required: true });
  const entity_id = V.int(fields.entity_id, 'entity_id', { required: true, min: 1 });
  await assertEntityAccess(req, entity_type, entity_id);
  if (!file) throw badRequest('No file was uploaded');

  const rule = ALLOWED[file.mimeType];
  if (!rule) throw badRequest(`File type "${file.mimeType}" is not allowed. Allowed: PDF, JPEG, PNG, WEBP.`);
  const buf = Buffer.concat(file.chunks);
  if (!buf.length) throw badRequest('Uploaded file is empty');
  if (!rule.magic(buf)) throw badRequest('File content does not match its declared type');

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const stored_name = `${randomId()}.${rule.ext}`; // generated id — never user input
  await storage.save(req.clinic.id, stored_name, buf);

  const created = await db.q1(`
    INSERT INTO attachments (clinic_id, entity_type, entity_id, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, entity_type, entity_id, original_name, mime_type, size_bytes, created_at
  `, [req.clinic.id, entity_type, entity_id, file.originalName, stored_name, file.mimeType, buf.length, sha256, req.user.id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'attachment.upload', entity: 'attachment', entityId: created.id,
    details: { entity_type, entity_id, mime_type: file.mimeType, size_bytes: buf.length } });
  res.status(201).json({ attachment: created });
}));

// GET /api/attachments?entity_type=&entity_id=
router.get('/', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const entity_type = V.oneOf(req.query.entity_type, 'entity_type', ['medical_record'], { required: true });
  const entity_id = V.int(req.query.entity_id, 'entity_id', { required: true, min: 1 });
  await assertEntityAccess(req, entity_type, entity_id);
  const items = await db.q(`
    SELECT id, entity_type, entity_id, original_name, mime_type, size_bytes, created_at
    FROM attachments WHERE clinic_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY id
  `, [req.clinic.id, entity_type, entity_id]);
  res.json({ attachments: items });
}));

// GET /api/attachments/:id/download — authenticated, authorized, audited; never public
router.get('/:id/download', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const row = await getOwnAttachment(req.clinic.id, id);
  await assertEntityAccess(req, row.entity_type, row.entity_id);
  const present = await storage.exists(req.clinic.id, row.stored_name);
  if (!present) throw notFound('Attachment file is missing from storage');
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'attachment.read', entity: 'attachment', entityId: id,
    details: { record_id: row.entity_id } });
  // RFC 5987 filename encoding (safe for Arabic names); inline=false forces download.
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stream = await storage.readStream(req.clinic.id, row.stored_name);
  stream.pipe(res);
}));

// DELETE /api/attachments/:id — soft delete (history preserved); uploader or owner
router.delete('/:id', requireAuth, requireClinic, requireRole(...PERMS.clinical), asyncH(async (req, res) => {
  const id = V.int(req.params.id, 'id', { required: true });
  const row = await getOwnAttachment(req.clinic.id, id);
  await assertEntityAccess(req, row.entity_type, row.entity_id);
  if (req.user.role !== 'owner' && row.uploaded_by !== req.user.id) {
    throw forbidden('Only the uploader or the clinic owner can remove an attachment');
  }
  await db.exec('UPDATE attachments SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  await audit(db, { clinicId: req.clinic.id, userId: req.user.id, action: 'attachment.delete', entity: 'attachment', entityId: id });
  res.json({ ok: true });
}));

module.exports = router;
