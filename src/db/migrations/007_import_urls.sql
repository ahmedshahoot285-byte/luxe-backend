-- ─────────────────────────────────────────────
--  IMPORT URLS
--  Tracks every Sephora Turkey URL ever submitted.
--  Decoupled from products so we can queue, retry,
--  and audit imports independently.
-- ─────────────────────────────────────────────

CREATE TYPE import_status_enum AS ENUM (
    'queued',       -- submitted, not yet processed
    'processing',   -- scraper is running
    'completed',    -- product saved successfully
    'updated',      -- existing product re-synced
    'failed',       -- scraper error; see error_message
    'skipped'       -- duplicate URL, no action taken
);

CREATE TABLE import_urls (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    url             TEXT                NOT NULL,

    status          import_status_enum  NOT NULL DEFAULT 'queued',

    -- Link to resulting product (NULL until import completes)
    product_id      UUID                REFERENCES products (id) ON DELETE SET NULL,

    -- Who triggered this import
    imported_by     UUID                REFERENCES users (id) ON DELETE SET NULL,

    -- Scraping result
    scraped_data    JSONB,              -- raw data from Playwright before transformation
    error_message   TEXT,
    attempt_count   SMALLINT            NOT NULL DEFAULT 0,
    last_attempted_at TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- BullMQ job reference
    job_id          TEXT,

    created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    -- Never import the same URL twice in the queue simultaneously
    CONSTRAINT import_urls_url_unique UNIQUE (url)
);

CREATE TRIGGER import_urls_updated_at
    BEFORE UPDATE ON import_urls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Queue worker polls for queued jobs
CREATE INDEX idx_import_urls_status     ON import_urls (status);
CREATE INDEX idx_import_urls_product    ON import_urls (product_id);

-- Admin log view (most recent first)
CREATE INDEX idx_import_urls_created    ON import_urls (created_at DESC);

-- Retry logic: find failed jobs under attempt threshold
CREATE INDEX idx_import_urls_retry      ON import_urls (status, attempt_count)
    WHERE status = 'failed';
