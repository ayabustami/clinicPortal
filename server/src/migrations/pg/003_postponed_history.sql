-- 003-postponed-history.sql — allow 'treatment_postponed' in dental history.
-- Additive constraint change only (superset of the 001 value list); no data modified.
ALTER TABLE dental_history DROP CONSTRAINT IF EXISTS dental_history_event_type_check;
ALTER TABLE dental_history ADD CONSTRAINT dental_history_event_type_check
  CHECK (event_type IN (
    'finding_created', 'finding_updated', 'finding_resolved',
    'treatment_planned', 'treatment_completed', 'treatment_cancelled',
    'treatment_reopened', 'treatment_postponed',
    'chart_config', 'correction'
  ));
