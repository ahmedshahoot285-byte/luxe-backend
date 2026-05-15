-- ─────────────────────────────────────────────
--  SYSTEM LOGS
--  Append-only table. Never updated, only inserted.
-- ─────────────────────────────────────────────

CREATE TYPE log_type_enum AS ENUM (
    'import',       -- product URL import event
    'sync',         -- scheduled price/stock sync
    'order',        -- order lifecycle event
    'auth',         -- admin login / logout
    'error'         -- unhandled errors
);

CREATE TYPE log_level_enum AS ENUM ('info', 'warn', 'error');

CREATE TABLE logs (
    id          BIGSERIAL       PRIMARY KEY,    -- BIGSERIAL: high-volume append
    type        log_type_enum   NOT NULL,
    level       log_level_enum  NOT NULL DEFAULT 'info',
    message     TEXT            NOT NULL,
    metadata    JSONB,                          -- e.g. {product_id, order_id, url}
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Admin log viewer filters by type and level
CREATE INDEX idx_logs_type      ON logs (type);
CREATE INDEX idx_logs_level     ON logs (level);
CREATE INDEX idx_logs_created   ON logs (created_at DESC);

-- JSONB path queries, e.g. find all logs for a given order_id
CREATE INDEX idx_logs_metadata  ON logs USING GIN (metadata);

-- Automatic cleanup: delete logs older than 90 days
-- (run via pg_cron or a nightly cron job)
-- DELETE FROM logs WHERE created_at < NOW() - INTERVAL '90 days';
