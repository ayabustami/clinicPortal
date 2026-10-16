'use strict';
/**
 * 003_backfill.js — one-time data backfill for columns added in 002.
 * Non-destructive: only fills NULL/derivative values.
 */
const { normalizeArabic } = require('../util/arabic');

module.exports = {
  up(db) {
    // 1. Normalized patient name derivatives
    const patients = db.prepare('SELECT id, first_name, last_name FROM patients').all();
    const updPatient = db.prepare('UPDATE patients SET first_name_norm = ?, last_name_norm = ? WHERE id = ?');
    const txPatients = db.transaction(() => {
      for (const p of patients) {
        updPatient.run(normalizeArabic(p.first_name), normalizeArabic(p.last_name), p.id);
      }
    });
    txPatients();

    // 2. Invoice currency snapshot from the owning clinic
    db.exec(`
      UPDATE invoices
      SET currency = (SELECT c.currency FROM clinics c WHERE c.id = invoices.clinic_id)
      WHERE currency IS NULL
    `);

    console.log(`[migrate] 003_backfill: normalized ${patients.length} patient names, set invoice currencies`);
  },
};
