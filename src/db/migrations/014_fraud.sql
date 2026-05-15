-- Anti-fraud columns on orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_ip   TEXT,
  ADD COLUMN IF NOT EXISTS fraud_score   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fraud_flags   JSONB   NOT NULL DEFAULT '[]';

-- Index for fast per-phone and per-IP lookups used by the fraud check
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone_created
  ON orders (customer_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_customer_ip_created
  ON orders (customer_ip, created_at DESC)
  WHERE customer_ip IS NOT NULL;
