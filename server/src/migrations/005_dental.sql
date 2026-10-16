-- 005_dental.sql — Interactive dental chart (odontogram).
-- Purely additive: four new tables + indexes. No existing table is touched,
-- so applying this to an installed database preserves all data.

-- One chart configuration row per patient (dentition is clinician-editable;
-- dentition_suggested stores the age-based suggestion for reference only).
CREATE TABLE dental_charts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  dentition TEXT NOT NULL DEFAULT 'permanent' CHECK (dentition IN ('permanent','primary','mixed')),
  dentition_suggested TEXT CHECK (dentition_suggested IN ('permanent','primary','mixed') OR dentition_suggested IS NULL),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_dental_charts_patient ON dental_charts(clinic_id, patient_id);

-- Layer A: current clinical findings. Multiple rows per tooth are allowed
-- (e.g. crown + root_canal). surfaces = '' means whole tooth; otherwise a
-- sorted comma list from {M,D,O,B,L} validated server-side.
-- tooth_number CHECK: FDI quadrant 1-4 with positions 1-8 (permanent),
-- quadrant 5-8 with positions 1-5 (primary).
CREATE TABLE dental_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  chart_id INTEGER NOT NULL REFERENCES dental_charts(id) ON DELETE CASCADE,
  tooth_number INTEGER NOT NULL CHECK (
    (tooth_number / 10 BETWEEN 1 AND 4 AND tooth_number % 10 BETWEEN 1 AND 8)
    OR (tooth_number / 10 BETWEEN 5 AND 8 AND tooth_number % 10 BETWEEN 1 AND 5)
  ),
  dentition TEXT NOT NULL CHECK (dentition IN ('permanent','primary')),
  condition TEXT NOT NULL CHECK (condition IN
    ('healthy','caries','filled','crown','missing','extracted','root_canal',
     'fractured','implant','bridge_pontic','bridge_abutment','impacted','other')),
  surfaces TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  note TEXT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  record_id INTEGER REFERENCES medical_records(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_dental_findings_patient ON dental_findings(clinic_id, patient_id, tooth_number);
-- Duplicate-submission guard: one ACTIVE finding per tooth+condition+surfaces.
CREATE UNIQUE INDEX uq_dental_findings_active
  ON dental_findings(clinic_id, patient_id, tooth_number, condition, surfaces)
  WHERE status = 'active';

-- Layers B + C: planned treatments and completed procedures (status lifecycle
-- planned -> completed | cancelled; reopening is audited, never silent).
CREATE TABLE dental_treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  chart_id INTEGER NOT NULL REFERENCES dental_charts(id) ON DELETE CASCADE,
  tooth_number INTEGER NOT NULL CHECK (
    (tooth_number / 10 BETWEEN 1 AND 4 AND tooth_number % 10 BETWEEN 1 AND 8)
    OR (tooth_number / 10 BETWEEN 5 AND 8 AND tooth_number % 10 BETWEEN 1 AND 5)
  ),
  dentition TEXT NOT NULL CHECK (dentition IN ('permanent','primary')),
  procedure TEXT NOT NULL CHECK (procedure IN
    ('filling','crown','extraction','root_canal','implant','bridge','cleaning','fluoride','other')),
  surfaces TEXT NOT NULL DEFAULT '',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled')),
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  record_id INTEGER REFERENCES medical_records(id) ON DELETE SET NULL,
  planned_by INTEGER REFERENCES users(id),
  planned_at TEXT NOT NULL,
  completion_note TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_dental_treatments_patient ON dental_treatments(clinic_id, patient_id, status);

-- Append-only clinical history (per tooth and patient timeline). Nothing here
-- is ever UPDATEd or DELETEd by routine operations; corrections add rows with
-- a reason and preserve old/new values.
CREATE TABLE dental_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_number INTEGER,
  dentition TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('finding_created','finding_updated','finding_resolved',
     'treatment_planned','treatment_completed','treatment_cancelled','treatment_reopened',
     'chart_config','correction')),
  entity TEXT NOT NULL CHECK (entity IN ('finding','treatment','chart')),
  entity_id INTEGER NOT NULL,
  old_value TEXT,                           -- JSON snapshot before the change
  new_value TEXT,                           -- JSON snapshot after the change
  reason TEXT,                              -- required for corrections/condition changes
  note TEXT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  record_id INTEGER REFERENCES medical_records(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_dental_history_patient ON dental_history(clinic_id, patient_id, created_at, id);
CREATE INDEX idx_dental_history_tooth ON dental_history(clinic_id, patient_id, tooth_number);
