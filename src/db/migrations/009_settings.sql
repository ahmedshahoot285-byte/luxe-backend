-- ─────────────────────────────────────────────
--  SETTINGS
--  Key-value store for runtime config:
--    exchange_rate, profit margins, shipping fee, etc.
--  Editable from admin dashboard without a deploy.
-- ─────────────────────────────────────────────

CREATE TABLE settings (
    key         TEXT        PRIMARY KEY,
    value       JSONB       NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID        REFERENCES users (id) ON DELETE SET NULL
);

CREATE TRIGGER settings_updated_at
    BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Seed default values ────────────────────────────────────────────────────

INSERT INTO settings (key, value, description) VALUES
    ('exchange_rate_try_lyd',   '0.15',                       'TRY → LYD conversion rate'),
    ('shipping_cost_lyd',       '25',                          'Flat shipping fee in LYD'),
    ('free_shipping_threshold',  '300',                        'Order total above which shipping is free (LYD)'),
    ('profit_margin_makeup',    '0.35',                        'Profit margin for makeup category (35%)'),
    ('profit_margin_skincare',  '0.40',                        'Profit margin for skincare category (40%)'),
    ('profit_margin_fragrance', '0.25',                        'Profit margin for fragrance category (25%)'),
    ('profit_margin_haircare',  '0.35',                        'Profit margin for haircare category (35%)'),
    ('sephora_base_url',        '"https://www.sephora.com.tr"','Sephora Turkey base URL for scraper'),
    ('whatsapp_admin_number',   '"218XXXXXXXXX"',              'Admin WhatsApp number for order notifications'),
    ('sync_enabled',            'true',                        'Enable/disable the daily sync cron job'),
    ('max_import_retries',      '3',                           'Max scrape attempts before marking failed');
