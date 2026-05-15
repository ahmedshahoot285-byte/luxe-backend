-- ─────────────────────────────────────────────────────────────────────────
-- 012_sync_jobs.sql
-- Tracks each full-catalog sync run and individual product sync results.
-- ─────────────────────────────────────────────────────────────────────────

-- One row per sync run (manual or scheduled)
CREATE TABLE IF NOT EXISTS sync_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger       TEXT        NOT NULL DEFAULT 'scheduled'
                            CHECK (trigger IN ('scheduled', 'manual')),
  status        TEXT        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),

  -- Counters (updated as the job progresses)
  total         INTEGER     NOT NULL DEFAULT 0,
  updated       INTEGER     NOT NULL DEFAULT 0,
  unchanged     INTEGER     NOT NULL DEFAULT 0,
  deleted       INTEGER     NOT NULL DEFAULT 0,
  failed        INTEGER     NOT NULL DEFAULT 0,

  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- One row per product per sync run
CREATE TABLE IF NOT EXISTS sync_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_job_id   UUID        NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  product_id    UUID,
  product_name  TEXT,
  result        TEXT        NOT NULL
                            CHECK (result IN ('updated', 'unchanged', 'deleted', 'failed')),
  -- What changed (price_lyd_before/after, stock_before/after)
  changes       JSONB,
  error_message TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sync_jobs_status_idx    ON sync_jobs(status);
CREATE INDEX IF NOT EXISTS sync_jobs_started_idx   ON sync_jobs(started_at DESC);
CREATE INDEX IF NOT EXISTS sync_logs_job_idx       ON sync_logs(sync_job_id);
CREATE INDEX IF NOT EXISTS sync_logs_product_idx   ON sync_logs(product_id);
CREATE INDEX IF NOT EXISTS sync_logs_result_idx    ON sync_logs(result);
