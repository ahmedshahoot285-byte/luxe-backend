-- ─────────────────────────────────────────────────────────────────────────
-- 013_perf_indexes.sql
-- Targeted indexes for the most common query patterns.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Products ──────────────────────────────────────────────────────────────

-- Default sort (newest active products) — covers the most common list page
CREATE INDEX IF NOT EXISTS idx_products_active_created
  ON products (created_at DESC)
  WHERE is_active = TRUE;

-- Price-range browsing for active products
CREATE INDEX IF NOT EXISTS idx_products_active_price
  ON products (price_lyd)
  WHERE is_active = TRUE;

-- Featured section (small result set, stays hot in buffer cache)
CREATE INDEX IF NOT EXISTS idx_products_active_featured
  ON products (created_at DESC)
  WHERE is_active = TRUE AND is_featured = TRUE;

-- New arrivals section
CREATE INDEX IF NOT EXISTS idx_products_active_new
  ON products (created_at DESC)
  WHERE is_active = TRUE AND is_new = TRUE;

-- Category browse (active products by category, newest first)
CREATE INDEX IF NOT EXISTS idx_products_category_active_created
  ON products (category_id, created_at DESC)
  WHERE is_active = TRUE;

-- Brand browse
CREATE INDEX IF NOT EXISTS idx_products_brand_active_created
  ON products (brand_id, created_at DESC)
  WHERE is_active = TRUE;

-- ── Orders ────────────────────────────────────────────────────────────────

-- Admin orders list (status filter + newest first)
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders (status, created_at DESC);

-- ── Settings ──────────────────────────────────────────────────────────────

-- Pricing config load is the hottest settings query; key is already PK,
-- but an index on the keys we always load together helps planner estimates.
-- (Primary key already covers single-key lookups; this is just documentation.)
