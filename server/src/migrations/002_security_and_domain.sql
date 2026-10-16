-- 002_security_and_domain.sql
-- Security + domain columns and tables. All additive (migration-safe).

-- Session revocation support
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;

-- Clinic-configurable currency (ISO 4217). Default ILS for the deployment market.
ALTER TABLE clinics ADD COLUMN currency TEXT NOT NULL DEFAULT 'ILS';

-- Currency snapshot per invoice (historical amounts keep their currency)
ALTER TABLE invoices ADD COLUMN currency TEXT;

-- Clinical record workflow: draft | approved (existing rows become approved)
ALTER TABLE medical_records ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';

-- Normalized search derivatives (display values are never modified)
ALTER TABLE patients ADD COLUMN first_name_norm TEXT;
ALTER TABLE patients ADD COLUMN last_name_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_patients_norm ON patients(clinic_id, first_name_norm, last_name_norm);

-- Doctor leave / unavailable periods
CREATE TABLE doctor_unavailability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,               -- UTC ISO-8601
  end_at TEXT NOT NULL,                 -- UTC ISO-8601 (exclusive)
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_unavail_doctor ON doctor_unavailability(doctor_id, start_at);
CREATE INDEX idx_unavail_clinic ON doctor_unavailability(clinic_id, start_at);

-- Medical document attachments (files stored under data/uploads with generated names)
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('medical_record')),
  entity_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,     -- generated UUID filename; user input never used in paths
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  deleted_at TEXT,                      -- soft delete preserves record history
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_attach_entity ON attachments(clinic_id, entity_type, entity_id);
