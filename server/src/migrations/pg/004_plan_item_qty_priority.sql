-- 004_plan_item_qty_priority.sql
-- Additive only: per-item quantity and priority so plans can express
-- "2 x composite" and sequence work per procedure. Backward compatible:
-- defaults keep every existing row valid (qty 1, routine priority).
-- Historical pricing stays on the item row (price_cents is a snapshot).

ALTER TABLE treatment_plan_items
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'routine';

DO $$ BEGIN
  ALTER TABLE treatment_plan_items DROP CONSTRAINT IF EXISTS treatment_plan_items_quantity_check;
  ALTER TABLE treatment_plan_items ADD CONSTRAINT treatment_plan_items_quantity_check CHECK (quantity >= 1 AND quantity <= 99);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE treatment_plan_items DROP CONSTRAINT IF EXISTS treatment_plan_items_priority_check;
  ALTER TABLE treatment_plan_items ADD CONSTRAINT treatment_plan_items_priority_check CHECK (priority IN ('urgent', 'high', 'routine', 'low'));
EXCEPTION WHEN others THEN NULL; END $$;

-- Indexes: only where 001/002 lacked coverage for measured access patterns.
-- (plan items by plan+sequence and appointments by clinic+start already exist
-- from 001/002; re-creating them here would waste write throughput.)
-- Timeline / history lookups per patient (new access pattern from the
-- filterable clinical activity log):
CREATE INDEX IF NOT EXISTS idx_dental_history_patient ON dental_history (patient_id, created_at);
