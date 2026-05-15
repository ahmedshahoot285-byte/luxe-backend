-- ─────────────────────────────────────────────
--  PRODUCTS
-- ─────────────────────────────────────────────

CREATE TYPE stock_status_enum AS ENUM (
    'in_stock',
    'low_stock',
    'out_of_stock'
);

CREATE TABLE products (
    id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             CITEXT           NOT NULL,
    name             TEXT             NOT NULL,
    description      TEXT,

    brand_id         UUID             REFERENCES brands (id) ON DELETE SET NULL,
    category_id      UUID             REFERENCES categories (id) ON DELETE SET NULL,

    -- Pricing (all stored/shown in LYD)
    price_lyd        NUMERIC(10, 2)   NOT NULL CHECK (price_lyd >= 0),

    -- Images stored as ordered JSON array
    -- e.g. [{"url":"https://...","alt":"Front view"}]
    images           JSONB            NOT NULL DEFAULT '[]',

    -- Variant matrix stored as JSON array
    -- e.g. [{"label":"50ml","sku":"CT-MC-50","price_lyd":285,"stock":12}]
    variants         JSONB            NOT NULL DEFAULT '[]',

    stock_status     stock_status_enum NOT NULL DEFAULT 'in_stock',
    stock_qty        INTEGER          NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),

    -- Source tracking
    original_url     TEXT             UNIQUE,   -- Sephora Turkey URL
    sephora_sku      TEXT,                       -- SKU scraped from source

    -- Flags
    is_active        BOOLEAN          NOT NULL DEFAULT TRUE,
    is_featured      BOOLEAN          NOT NULL DEFAULT FALSE,
    is_new           BOOLEAN          NOT NULL DEFAULT FALSE,

    -- Sync metadata
    last_synced_at   TIMESTAMPTZ,
    sync_hash        TEXT,              -- hash of scraped data; change = needs update

    created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    CONSTRAINT products_slug_unique UNIQUE (slug)
);

-- Triggers: keep updated_at current
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Slug lookup (product detail page)
CREATE INDEX idx_products_slug        ON products (slug);

-- Browse by brand / category
CREATE INDEX idx_products_brand       ON products (brand_id);
CREATE INDEX idx_products_category    ON products (category_id);

-- Active products filter (used in almost every query)
CREATE INDEX idx_products_active      ON products (is_active) WHERE is_active = TRUE;

-- Featured / new arrivals sections
CREATE INDEX idx_products_featured    ON products (is_featured) WHERE is_featured = TRUE;
CREATE INDEX idx_products_new         ON products (is_new, created_at DESC) WHERE is_new = TRUE;

-- Price-range filters
CREATE INDEX idx_products_price       ON products (price_lyd);

-- Stock management
CREATE INDEX idx_products_stock       ON products (stock_status);

-- Sync engine: quickly find stale products
CREATE INDEX idx_products_synced      ON products (last_synced_at);

-- Full-text search across name + description
CREATE INDEX idx_products_fts ON products
    USING GIN (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));
