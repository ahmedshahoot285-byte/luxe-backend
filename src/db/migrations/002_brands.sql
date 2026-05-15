-- ─────────────────────────────────────────────
--  BRANDS
--  Lookup table.  Products reference brand_id.
-- ─────────────────────────────────────────────

CREATE TABLE brands (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        CITEXT      NOT NULL,
    slug        CITEXT      NOT NULL,
    logo_url    TEXT,
    origin      TEXT,                          -- e.g. 'France', 'USA'
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT brands_name_unique UNIQUE (name),
    CONSTRAINT brands_slug_unique UNIQUE (slug)
);

-- Fast lookup by slug (used in URL routing)
CREATE INDEX idx_brands_slug ON brands (slug);
