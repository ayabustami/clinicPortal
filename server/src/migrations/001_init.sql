-- 001_init.sql : Clinic Management Portal initial schema
-- Portable SQL (tested on SQLite; types chosen to map cleanly to PostgreSQL).

CREATE TABLE clinics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  email TEXT,
  phone TEXT,
  address TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  working_hours TEXT NOT NULL DEFAULT '{}',  -- JSON: {"0":{"start":"08:00","end":"17:00"}, ...} 0=Sunday
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_branches_clinic ON branches(clinic_id);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,  -- NULL for platform admins
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','owner','receptionist','doctor','accountant')),
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_clinic ON users(clinic_id);

CREATE TABLE doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- set when the doctor has a login
  name TEXT NOT NULL,
  specialty TEXT,
  color TEXT NOT NULL DEFAULT '#0d8f7e',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_doctors_clinic ON doctors(clinic_id);

CREATE TABLE patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  mrn TEXT NOT NULL,                       -- patient number, unique per clinic
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,                                -- YYYY-MM-DD
  gender TEXT CHECK (gender IN ('male','female','other') OR gender IS NULL),
  phone TEXT,
  email TEXT,
  address TEXT,
  allergies TEXT,
  medical_info TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (clinic_id, mrn)
);
CREATE INDEX idx_patients_clinic ON patients(clinic_id);
CREATE INDEX idx_patients_name ON patients(clinic_id, last_name, first_name);

CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price_cents INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_services_clinic ON services(clinic_id);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  service_id INTEGER REFERENCES services(id),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','checked_in','completed','cancelled','no_show')),
  start_at TEXT NOT NULL,                  -- UTC ISO-8601, e.g. 2026-10-12T08:30:00.000Z
  duration_min INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min <= 480),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_appt_clinic_time ON appointments(clinic_id, start_at);
CREATE INDEX idx_appt_doctor_time ON appointments(doctor_id, start_at);
CREATE INDEX idx_appt_patient ON appointments(patient_id);

CREATE TABLE medical_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  visit_date TEXT NOT NULL,                -- YYYY-MM-DD (clinic local date)
  symptoms TEXT,
  examination TEXT,
  diagnosis TEXT,
  treatment TEXT,
  follow_up TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_records_patient ON medical_records(clinic_id, patient_id);
CREATE INDEX idx_records_doctor ON medical_records(doctor_id);

CREATE TABLE prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  medication TEXT NOT NULL,
  dosage TEXT,
  frequency TEXT,
  duration TEXT,
  notes TEXT,
  prescribed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rx_record ON prescriptions(record_id);
CREATE INDEX idx_rx_patient ON prescriptions(clinic_id, patient_id);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  issue_date TEXT NOT NULL,                -- YYYY-MM-DD
  due_date TEXT,
  notes TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (clinic_id, invoice_no)
);
CREATE INDEX idx_invoices_clinic ON invoices(clinic_id, issue_date);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);

CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_items_invoice ON invoice_items(invoice_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','bank_transfer','insurance','other')),
  reference TEXT,
  paid_at TEXT NOT NULL,                   -- UTC ISO-8601
  received_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_clinic ON payments(clinic_id, paid_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,                            -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_clinic ON audit_logs(clinic_id, id);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity_clinic ON activity(clinic_id, id);
