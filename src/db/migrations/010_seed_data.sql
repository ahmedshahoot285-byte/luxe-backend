-- ─────────────────────────────────────────────
--  SEED DATA  (development only)
-- ─────────────────────────────────────────────

-- ── Brands ────────────────────────────────────

INSERT INTO brands (id, name, slug, origin) VALUES
    (gen_random_uuid(), 'Charlotte Tilbury',  'charlotte-tilbury', 'UK'),
    (gen_random_uuid(), 'NARS',               'nars',              'USA'),
    (gen_random_uuid(), 'Dior Beauty',        'dior-beauty',       'France'),
    (gen_random_uuid(), 'YSL Beauty',         'ysl-beauty',        'France'),
    (gen_random_uuid(), 'Fenty Beauty',       'fenty-beauty',      'USA'),
    (gen_random_uuid(), 'La Mer',             'la-mer',            'USA'),
    (gen_random_uuid(), 'Kiehl''s',           'kiehls',            'USA');

-- ── Categories ────────────────────────────────

-- Top-level
INSERT INTO categories (id, name, slug, sort_order) VALUES
    ('11111111-0000-0000-0000-000000000001', 'Skincare',   'skincare',   1),
    ('11111111-0000-0000-0000-000000000002', 'Makeup',     'makeup',     2),
    ('11111111-0000-0000-0000-000000000003', 'Fragrance',  'fragrance',  3),
    ('11111111-0000-0000-0000-000000000004', 'Haircare',   'haircare',   4),
    ('11111111-0000-0000-0000-000000000005', 'Gifts',      'gifts',      5);

-- Sub-categories (Skincare)
INSERT INTO categories (name, slug, parent_id, sort_order) VALUES
    ('Moisturisers', 'moisturisers', '11111111-0000-0000-0000-000000000001', 1),
    ('Serums',       'serums',       '11111111-0000-0000-0000-000000000001', 2),
    ('Cleansers',    'cleansers',    '11111111-0000-0000-0000-000000000001', 3),
    ('Eye Cream',    'eye-cream',    '11111111-0000-0000-0000-000000000001', 4);

-- Sub-categories (Makeup)
INSERT INTO categories (name, slug, parent_id, sort_order) VALUES
    ('Foundation',  'foundation',  '11111111-0000-0000-0000-000000000002', 1),
    ('Lips',        'lips',        '11111111-0000-0000-0000-000000000002', 2),
    ('Eyes',        'eyes',        '11111111-0000-0000-0000-000000000002', 3),
    ('Blush',       'blush',       '11111111-0000-0000-0000-000000000002', 4);

-- ── Admin user ────────────────────────────────
-- Password: 'admin123' hashed with bcrypt (replace in production)

INSERT INTO users (id, role, name, phone, email, password_hash) VALUES
    (
        gen_random_uuid(),
        'admin',
        'Admin',
        '218910000000',
        'admin@luxe.ly',
        '$2b$12$placeholder_replace_this_hash_in_production'
    );
