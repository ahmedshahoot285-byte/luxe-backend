-- ─────────────────────────────────────────────────────────────────────────────
-- 011_catalog_jobs.sql
-- Tracks bulk catalog scrape/import sessions (one row per category URL submit)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog_jobs (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The category / brand URL that was scraped
  url             TEXT          NOT NULL,

  -- Current lifecycle state
  status          TEXT          NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','completed','failed')),

  -- Inputs
  max_pages       INTEGER       NOT NULL DEFAULT 10,

  -- Outputs (filled after completion)
  total_pages     INTEGER,
  scraped_pages   INTEGER,
  product_count   INTEGER,          -- number of product URLs queued
  error_message   TEXT,

  -- Timestamps
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS catalog_jobs_status_idx ON catalog_jobs(status);
CREATE INDEX IF NOT EXISTS catalog_jobs_created_at_idx ON catalog_jobs(created_at DESC);
