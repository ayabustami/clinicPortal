-- 005_drop_dup_index.sql
-- 004 initially created idx_appointments_clinic_start, duplicating
-- idx_appt_clinic_time from 001 (same columns). Drop the duplicate:
-- every appointment write was maintaining two identical indexes.
DROP INDEX IF EXISTS idx_appointments_clinic_start;
