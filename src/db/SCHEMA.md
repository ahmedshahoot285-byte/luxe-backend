# Database Schema Reference

## Entity Relationship Diagram

```
brands                     categories
──────                     ──────────
id  PK                     id          PK
name  CITEXT UNIQUE        name        CITEXT UNIQUE
slug  CITEXT UNIQUE        slug        CITEXT UNIQUE
logo_url                   parent_id   FK → categories.id (self-ref)
origin                     description
is_active                  image_url
created_at                 sort_order
                           is_active
                           created_at
       │                          │
       │ brand_id                 │ category_id
       ▼                          ▼
                  products
                  ────────
                  id              PK
                  slug            CITEXT UNIQUE
                  name
                  description
                  brand_id        FK → brands.id
                  category_id     FK → categories.id
                  price_lyd       NUMERIC
                  images          JSONB  [{url, alt}]
                  variants        JSONB  [{label, sku, price_lyd, stock}]
                  stock_status    ENUM
                  stock_qty
                  original_url    UNIQUE  ← Sephora Turkey URL
                  sephora_sku
                  is_active / is_featured / is_new
                  last_synced_at
                  sync_hash
                  created_at / updated_at
                       │
              ┌────────┴─────────┐
              │                  │
              ▼                  ▼
        order_items         import_urls
        ───────────         ───────────
        id          PK      id            PK
        order_id    FK      url           UNIQUE
        product_id  FK      status        ENUM
        product_name        product_id    FK → products.id
        product_brand       imported_by   FK → users.id
        variant_label       scraped_data  JSONB
        unit_price_lyd      error_message
        quantity            attempt_count
        line_total_lyd      last_attempted_at
        created_at          completed_at
              │             job_id
              │             created_at / updated_at
              ▼
            orders
            ──────
            id                PK
            order_number      UNIQUE  (ORD-00001)
            user_id           FK → users.id
            customer_name
            customer_phone
            customer_city
            customer_address
            customer_notes
            subtotal_lyd
            shipping_lyd
            total_lyd         GENERATED
            status            ENUM
            status_updated_at
            whatsapp_sent
            whatsapp_sent_at
            admin_notes
            cancelled_reason
            created_at / updated_at
              │
              ▼
            users
            ─────
            id              PK
            role            ENUM  (admin | customer)
            name
            phone           UNIQUE
            email           UNIQUE (nullable)
            city
            password_hash   (admin only)
            last_login_at
            order_count
            is_blocked
            created_at / updated_at


settings (key-value)
────────────────────
key           PK
value         JSONB
description
updated_at
updated_by    FK → users.id

logs (append-only)
──────────────────
id            BIGSERIAL PK
type          ENUM  (import | sync | order | auth | error)
level         ENUM  (info | warn | error)
message
metadata      JSONB
created_at
```

## Enum Types

| Type | Values |
|---|---|
| `stock_status_enum` | `in_stock`, `low_stock`, `out_of_stock` |
| `order_status_enum` | `placed`, `pending`, `confirmed`, `purchased`, `shipped`, `delivered`, `cancelled` |
| `import_status_enum` | `queued`, `processing`, `completed`, `updated`, `failed`, `skipped` |
| `user_role_enum` | `admin`, `customer` |
| `log_type_enum` | `import`, `sync`, `order`, `auth`, `error` |
| `log_level_enum` | `info`, `warn`, `error` |

## Index Summary

| Table | Index | Purpose |
|---|---|---|
| products | `idx_products_slug` | Product detail page lookup |
| products | `idx_products_brand` | Browse by brand |
| products | `idx_products_category` | Browse by category |
| products | `idx_products_active` | Partial — only active rows |
| products | `idx_products_price` | Price range filter |
| products | `idx_products_fts` | GIN full-text search |
| products | `idx_products_synced` | Sync engine: find stale rows |
| orders | `idx_orders_status` | Admin order list by status |
| orders | `idx_orders_created` | Time-sorted order list |
| orders | `idx_orders_phone` | Look up orders by customer phone |
| import_urls | `idx_import_urls_retry` | Partial — failed jobs only |
| logs | `idx_logs_metadata` | GIN JSONB path queries |
