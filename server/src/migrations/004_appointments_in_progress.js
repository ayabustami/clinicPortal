'use strict';
/**
 * 004_appointments_in_progress.js
 * SQLite cannot ALTER a CHECK constraint, so the appointments table is rebuilt
 * using the documented 12-step procedure with foreign_keys OFF (toggled OUTSIDE
 * the transaction, as required by SQLite). All rows and relationships are
 * preserved; ON DELETE SET NULL references from medical_records/invoices are
 * NOT triggered because DROP runs with foreign_keys OFF.
 */
module.exports = {
  up(db) {
    db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        db.exec(`
          CREATE TABLE appointments_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
            branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
            patient_id INTEGER NOT NULL REFERENCES patients(id),
            doctor_id INTEGER NOT NULL REFERENCES doctors(id),
            service_id INTEGER REFERENCES services(id),
            status TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled','confirmed','checked_in','in_progress','completed','cancelled','no_show')),
            start_at TEXT NOT NULL,
            duration_min INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min <= 480),
            notes TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          );

          INSERT INTO appointments_new
            (id, clinic_id, branch_id, patient_id, doctor_id, service_id, status,
             start_at, duration_min, notes, created_by, created_at, updated_at)
          SELECT id, clinic_id, branch_id, patient_id, doctor_id, service_id, status,
                 start_at, duration_min, notes, created_by, created_at, updated_at
          FROM appointments;

          DROP TABLE appointments;
          ALTER TABLE appointments_new RENAME TO appointments;

          CREATE INDEX idx_appt_clinic_time ON appointments(clinic_id, start_at);
          CREATE INDEX idx_appt_doctor_time ON appointments(doctor_id, start_at);
          CREATE INDEX idx_appt_patient ON appointments(patient_id);
        `);
      });
      run();
      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new Error(`foreign_key_check failed after appointments rebuild: ${JSON.stringify(violations.slice(0, 3))}`);
      }
      const count = db.prepare('SELECT COUNT(*) AS c FROM appointments').get().c;
      console.log(`[migrate] 004: appointments rebuilt with in_progress status (${count} rows preserved)`);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  },
};
