-- ─────────────────────────────────────────────
--  CATEGORIES
--  Self-referencing tree (parent_id) allows:
--    Beauty > Skincare > Serums
-- ─────────────────────────────────────────────

CREATE TABLE categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        CITEXT      NOT NULL,
    slug        CITEXT      NOT NULL,
    parent_id   UUID        REFERENCES categories (id) ON DELETE SET NULL,
    description TEXT,
    image_url   TEXT,
    sort_order  SMALLINT    NOT NULL DEFAULT 0,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT categories_slug_unique UNIQUE (slug)
);

-- Recursive tree traversal
CREATE INDEX idx_categories_parent   ON categories (parent_id);
CREATE INDEX idx_categories_slug     ON categories (slug);
CREATE INDEX idx_categories_active   ON categories (is_active) WHERE is_active = TRUE;
