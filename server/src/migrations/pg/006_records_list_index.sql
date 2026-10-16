-- 006_records_list_index.sql
-- The Medical Records list (dentists' primary clinical list view) pages with
-- ORDER BY visit_date DESC, id DESC LIMIT n per clinic. EXPLAIN on a 60k-record
-- dataset showed a parallel seq scan + ~2.6MB quicksort per page; with this
-- index the same page is a 50-row index scan (<1ms). Additive, no data change.
CREATE INDEX IF NOT EXISTS idx_records_clinic_date
  ON medical_records (clinic_id, visit_date DESC, id DESC);
