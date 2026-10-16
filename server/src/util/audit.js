'use strict';
const { nowIso } = require('./time');

/**
 * Write an audit log row for sensitive clinical/financial/admin changes.
 * `t` is a db runner (pool helpers or a transaction handle) so audit rows can
 * be written inside the same transaction as the change they describe.
 */
async function audit(t, { clinicId, userId, action, entity, entityId, details }) {
  await t.exec(
    `INSERT INTO audit_logs (clinic_id, user_id, action, entity, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clinicId || null, userId || null, action, entity, entityId || null,
      details ? JSON.stringify(details) : null, nowIso()]
  );
}

/** Push a message into the clinic activity feed. */
async function logActivity(t, { clinicId, userId, kind = 'info', message }) {
  await t.exec(
    `INSERT INTO activity (clinic_id, user_id, kind, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [clinicId, userId || null, kind, message, nowIso()]
  );
}

module.exports = { audit, logActivity };
