-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enable case-insensitive text (used on email/slug columns)
CREATE EXTENSION IF NOT EXISTS "citext";
