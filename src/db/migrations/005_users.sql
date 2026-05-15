-- ─────────────────────────────────────────────
--  USERS
--  Covers two roles:
--    'admin'    → staff who manage the dashboard
--    'customer' → people who place orders
--                 (customers don't register; captured at checkout)
-- ─────────────────────────────────────────────

CREATE TYPE user_role_enum AS ENUM ('admin', 'customer');

CREATE TABLE users (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    role            user_role_enum  NOT NULL DEFAULT 'customer',

    -- Identity
    name            TEXT            NOT NULL,
    phone           TEXT            NOT NULL,        -- primary contact in Libya
    email           CITEXT,                          -- optional for customers
    city            TEXT,

    -- Admin auth (only populated when role = 'admin')
    password_hash   TEXT,
    last_login_at   TIMESTAMPTZ,

    -- Anti-spam
    order_count     INTEGER         NOT NULL DEFAULT 0,
    is_blocked      BOOLEAN         NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- A phone number identifies a unique customer
    CONSTRAINT users_phone_unique UNIQUE (phone),

    -- Email unique only when provided
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_users_phone    ON users (phone);
CREATE INDEX idx_users_role     ON users (role);
CREATE INDEX idx_users_blocked  ON users (is_blocked) WHERE is_blocked = TRUE;
