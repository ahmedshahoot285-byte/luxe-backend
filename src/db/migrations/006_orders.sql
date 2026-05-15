-- ─────────────────────────────────────────────
--  ORDERS + ORDER ITEMS
-- ─────────────────────────────────────────────

CREATE TYPE order_status_enum AS ENUM (
    'placed',       -- customer submitted form
    'pending',      -- waiting for admin confirmation
    'confirmed',    -- admin confirmed, ready to purchase from Sephora
    'purchased',    -- item bought on Sephora Turkey
    'shipped',      -- in transit to Libya
    'delivered',    -- handed to customer
    'cancelled'     -- cancelled by admin or customer
);

CREATE TABLE orders (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number        TEXT                NOT NULL,   -- human-readable: ORD-00042

    -- Customer snapshot (denormalised so order is self-contained even if user changes)
    user_id             UUID                REFERENCES users (id) ON DELETE SET NULL,
    customer_name       TEXT                NOT NULL,
    customer_phone      TEXT                NOT NULL,
    customer_city       TEXT                NOT NULL,
    customer_address    TEXT                NOT NULL,
    customer_notes      TEXT,

    -- Totals (LYD)
    subtotal_lyd        NUMERIC(10, 2)      NOT NULL CHECK (subtotal_lyd >= 0),
    shipping_lyd        NUMERIC(10, 2)      NOT NULL DEFAULT 0 CHECK (shipping_lyd >= 0),
    total_lyd           NUMERIC(10, 2)      NOT NULL GENERATED ALWAYS AS (subtotal_lyd + shipping_lyd) STORED,

    -- Workflow
    status              order_status_enum   NOT NULL DEFAULT 'placed',
    status_updated_at   TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    -- WhatsApp
    whatsapp_sent       BOOLEAN             NOT NULL DEFAULT FALSE,
    whatsapp_sent_at    TIMESTAMPTZ,

    -- Internal
    admin_notes         TEXT,
    cancelled_reason    TEXT,

    created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    CONSTRAINT orders_number_unique UNIQUE (order_number)
);

CREATE TRIGGER orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-generate order number: ORD-00001, ORD-00002 …
CREATE SEQUENCE order_number_seq START 1;

CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.order_number = 'ORD-' || LPAD(nextval('order_number_seq')::TEXT, 5, '0');
    RETURN NEW;
END;
$$;

CREATE TRIGGER orders_set_number
    BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- ── Order Items ────────────────────────────────────────────────────────────

CREATE TABLE order_items (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID            NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id      UUID            REFERENCES products (id) ON DELETE SET NULL,

    -- Snapshot at time of order (prices can change later)
    product_name    TEXT            NOT NULL,
    product_brand   TEXT,
    variant_label   TEXT,           -- e.g. "50ml" or "Shade: Syracuse"
    unit_price_lyd  NUMERIC(10, 2)  NOT NULL CHECK (unit_price_lyd >= 0),
    quantity        SMALLINT        NOT NULL DEFAULT 1 CHECK (quantity > 0),
    line_total_lyd  NUMERIC(10, 2)  NOT NULL GENERATED ALWAYS AS (unit_price_lyd * quantity) STORED,

    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Orders list (most recent first is default)
CREATE INDEX idx_orders_status      ON orders (status);
CREATE INDEX idx_orders_created     ON orders (created_at DESC);
CREATE INDEX idx_orders_user        ON orders (user_id);
CREATE INDEX idx_orders_phone       ON orders (customer_phone);
CREATE INDEX idx_orders_number      ON orders (order_number);

-- Join from order → items
CREATE INDEX idx_order_items_order  ON order_items (order_id);
CREATE INDEX idx_order_items_product ON order_items (product_id);
