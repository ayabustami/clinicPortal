-- Rate-limit counters (DB-backed so limits survive restarts and work across instances).
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  reset_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits (reset_at);
