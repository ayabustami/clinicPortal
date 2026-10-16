-- 010: link a treatment plan to the visit it was created from (Stage L).
-- Additive only; existing plans keep NULL and remain valid.
ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_plans_appointment ON treatment_plans (clinic_id, appointment_id);
