-- Backup run history
-- Records every scheduled or manual backup, including file locations and sizes.

CREATE TABLE IF NOT EXISTS backup_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by          TEXT        NOT NULL DEFAULT 'scheduler',  -- 'scheduler' | 'manual'
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at           TIMESTAMPTZ,
  status                TEXT        NOT NULL DEFAULT 'running',    -- 'running' | 'completed' | 'failed'

  -- Database snapshot (all key tables as JSON)
  db_file               TEXT,
  db_size_bytes         BIGINT,

  -- Products snapshot (active products with full detail)
  products_file         TEXT,
  products_count        INTEGER,
  products_size_bytes   BIGINT,

  error                 TEXT,
  retain_until          TIMESTAMPTZ NOT NULL
                          DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started   ON backup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status    ON backup_runs (status);
CREATE INDEX IF NOT EXISTS idx_backup_runs_retain    ON backup_runs (retain_until);
