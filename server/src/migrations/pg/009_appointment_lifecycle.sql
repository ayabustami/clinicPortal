-- 009: appointment lifecycle domain upgrade (Stage K).
-- Adds FIRST-CLASS, independently queryable arrival and clinical-visit
-- projections plus cancellation metadata and booking source. The operational
-- `status` column remains the single writer-driven lifecycle state machine;
-- arrival_status / visit_status are maintained in the same transaction as
-- every status change (single writer = no divergence).
-- Additive only: no column/table drops, no rewrites of existing semantics.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS arrival_status TEXT NOT NULL DEFAULT 'not_arrived'
  CHECK (arrival_status IN ('not_arrived', 'arrived', 'no_show'));

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS visit_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (visit_status IN ('not_started', 'in_progress', 'completed'));

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'reception'
  CHECK (booking_source IN ('reception', 'phone', 'online', 'referral', 'other'));

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appt_arrival ON appointments (clinic_id, arrival_status);
CREATE INDEX IF NOT EXISTS idx_appt_visit   ON appointments (clinic_id, visit_status);

-- Backfill projections from the legacy composite status so existing records
-- keep telling the truth: checked_in/in_progress/completed => arrived,
-- no_show => no_show; in_progress/completed map onto the visit lifecycle.
UPDATE appointments SET
  arrival_status = CASE
    WHEN status IN ('checked_in', 'in_progress', 'completed') THEN 'arrived'
    WHEN status = 'no_show' THEN 'no_show'
    ELSE 'not_arrived' END,
  visit_status = CASE
    WHEN status = 'completed' THEN 'completed'
    WHEN status = 'in_progress' THEN 'in_progress'
    ELSE 'not_started' END,
  cancelled_at = CASE
    WHEN status = 'cancelled' THEN updated_at
    ELSE cancelled_at END;
