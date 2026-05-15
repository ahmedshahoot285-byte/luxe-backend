import { db } from "../db";
import { cache, TTL } from "../utils/cache";
import { NotFoundError, ConflictError } from "../utils/errors";
import { slugify, uniqueSlug } from "../utils/slugify";

// ── Types ─────────────────────────────────────────────────────────────────

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface ProductImage {
  url: string;
  alt?: string;
}

export interface ProductVariant {
  label: string;
  sku?: string;
  price_lyd: number;
  stock: number;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  description?: string;
  brand_id?: string;
  brand_name?: string;
  category_id?: string;
  category_name?: string;
  price_lyd: number;
  images: ProductImage[];
  variants: ProductVariant[];
  stock_status: StockStatus;
  stock_qty: number;
  original_url?: string;
  sephora_sku?: string;
  is_active: boolean;
  is_featured: boolean;
  is_new: boolean;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

// Lightweight shape returned by list queries (no description, no variants)
export interface ProductListItem extends Omit<Product, "description" | "variants"> {
  total_count: number; // injected by window function
}

export interface CreateProductInput {
  name: string;
  description?: string;
  brand_id?: string;
  category_id?: string;
  price_lyd: number;
  images?: ProductImage[];
  variants?: ProductVariant[];
  stock_status?: StockStatus;
  stock_qty?: number;
  original_url?: string;
  sephora_sku?: string;
  is_featured?: boolean;
  is_new?: boolean;
}

export interface UpdateProductInput extends Partial<CreateProductInput> {
  is_active?: boolean;
}

export interface ProductFilters {
  category_id?: string;
  brand_id?: string;
  stock_status?: StockStatus;
  is_active?: boolean;
  is_featured?: boolean;
  search?: string;
  min_price?: number;
  max_price?: number;
  page?: number;
  limit?: number;
  sort?: "price_asc" | "price_desc" | "newest" | "name_asc";
}

// ── Cache helpers ─────────────────────────────────────────────────────────

function listCacheKey(filters: ProductFilters): string {
  return `products:list:${JSON.stringify(filters)}`;
}

function invalidateProductCache(id?: string, slug?: string): void {
  cache.invalidatePrefix("products:list:");
  if (id)   cache.del(`products:id:${id}`);
  if (slug) cache.del(`products:slug:${slug}`);
}

// ── Model ─────────────────────────────────────────────────────────────────

export const ProductModel = {

  async findAll(filters: ProductFilters = {}): Promise<{ products: ProductListItem[]; total: number }> {
    const cacheKey = listCacheKey(filters);
    const cached = cache.get<{ products: ProductListItem[]; total: number }>(cacheKey);
    if (cached) return cached;

    const {
      page = 1,
      limit = 20,
      sort = "newest",
      search,
      category_id,
      brand_id,
      stock_status,
      is_active = true,
      is_featured,
      min_price,
      max_price,
    } = filters;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    // Use a literal for the common is_active = TRUE case so PostgreSQL
    // picks up the partial index (idx_products_active) instead of doing a
    // full table scan with a bind parameter.
    if (is_active === true) {
      conditions.push("p.is_active = TRUE");
    } else if (is_active === false) {
      conditions.push("p.is_active = FALSE");
    }

    if (category_id) {
      conditions.push(`p.category_id = $${p++}`);
      params.push(category_id);
    }
    if (brand_id) {
      conditions.push(`p.brand_id = $${p++}`);
      params.push(brand_id);
    }
    if (stock_status) {
      conditions.push(`p.stock_status = $${p++}::stock_status_enum`);
      params.push(stock_status);
    }
    if (is_featured !== undefined) {
      conditions.push(`p.is_featured = $${p++}`);
      params.push(is_featured);
    }
    if (min_price !== undefined) {
      conditions.push(`p.price_lyd >= $${p++}`);
      params.push(min_price);
    }
    if (max_price !== undefined) {
      conditions.push(`p.price_lyd <= $${p++}`);
      params.push(max_price);
    }
    if (search) {
      conditions.push(
        `to_tsvector('english', coalesce(p.name,'') || ' ' || coalesce(p.description,'')) @@ plainto_tsquery('english', $${p++})`
      );
      params.push(search);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const orderMap: Record<string, string> = {
      newest:    "p.created_at DESC",
      price_asc: "p.price_lyd ASC",
      price_desc:"p.price_lyd DESC",
      name_asc:  "p.name ASC",
    };
    const orderBy = orderMap[sort] ?? "p.created_at DESC";

    // Single query: COUNT(*) OVER() eliminates the separate count round-trip.
    // Explicit column list: omit description + variants (heavy JSONB) for list views.
    const result = await db.query<ProductListItem & { total_count: string }>(
      `SELECT
         p.id, p.slug, p.name,
         p.brand_id, p.category_id,
         p.price_lyd,
         p.images,
         p.stock_status, p.stock_qty,
         p.original_url, p.sephora_sku,
         p.is_active, p.is_featured, p.is_new,
         p.last_synced_at, p.created_at, p.updated_at,
         b.name  AS brand_name,
         c.name  AS category_name,
         COUNT(*) OVER() AS total_count
       FROM products p
       LEFT JOIN brands     b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    const total    = result.rows.length > 0 ? parseInt(result.rows[0].total_count as unknown as string, 10) : 0;
    const products = result.rows.map(({ total_count: _tc, ...rest }) => rest as ProductListItem);

    const payload = { products, total };
    cache.set(cacheKey, payload, TTL.PRODUCTS);
    return payload;
  },

  async findById(id: string): Promise<Product> {
    const cacheKey = `products:id:${id}`;
    const cached = cache.get<Product>(cacheKey);
    if (cached) return cached;

    const result = await db.query<Product>(
      `SELECT
         p.*,
         b.name AS brand_name,
         c.name AS category_name
       FROM products p
       LEFT JOIN brands     b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundError("Product");
    cache.set(cacheKey, result.rows[0], TTL.PRODUCT);
    return result.rows[0];
  },

  async findBySlug(slug: string): Promise<Product> {
    const cacheKey = `products:slug:${slug}`;
    const cached = cache.get<Product>(cacheKey);
    if (cached) return cached;

    const result = await db.query<Product>(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name
       FROM products p
       LEFT JOIN brands     b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.slug = $1`,
      [slug]
    );
    if (!result.rows[0]) throw new NotFoundError("Product");
    cache.set(cacheKey, result.rows[0], TTL.PRODUCT);
    return result.rows[0];
  },

  async create(input: CreateProductInput): Promise<Product> {
    if (input.original_url) {
      const existing = await db.query(
        "SELECT id FROM products WHERE original_url = $1",
        [input.original_url]
      );
      if (existing.rows[0]) {
        throw new ConflictError("A product with this URL already exists");
      }
    }

    const product = await db.transaction(async (client) => {
      const idResult = await client.query<{ id: string }>(
        "SELECT gen_random_uuid() AS id"
      );
      const id   = idResult.rows[0].id;
      const slug = uniqueSlug(input.name, id);

      const result = await client.query<Product>(
        `INSERT INTO products (
           id, slug, name, description, brand_id, category_id,
           price_lyd, images, variants, stock_status, stock_qty,
           original_url, sephora_sku, is_featured, is_new
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14, $15
         ) RETURNING *`,
        [
          id, slug, input.name,
          input.description ?? null,
          input.brand_id    ?? null,
          input.category_id ?? null,
          input.price_lyd,
          JSON.stringify(input.images   ?? []),
          JSON.stringify(input.variants ?? []),
          input.stock_status ?? "in_stock",
          input.stock_qty    ?? 0,
          input.original_url ?? null,
          input.sephora_sku  ?? null,
          input.is_featured  ?? false,
          input.is_new       ?? false,
        ]
      );
      return result.rows[0];
    });

    // New product — bust list cache
    invalidateProductCache(product.id, product.slug);
    return product;
  },

  async update(id: string, input: UpdateProductInput): Promise<Product> {
    const existing = await this.findById(id); // throws 404 if not found

    if (input.original_url) {
      const dup = await db.query(
        "SELECT id FROM products WHERE original_url = $1 AND id <> $2",
        [input.original_url, id]
      );
      if (dup.rows[0]) throw new ConflictError("Another product already uses this URL");
    }

    const fields: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    const allowed: (keyof UpdateProductInput)[] = [
      "name", "description", "brand_id", "category_id",
      "price_lyd", "stock_status", "stock_qty",
      "original_url", "sephora_sku",
      "is_active", "is_featured", "is_new",
    ];
    for (const key of allowed) {
      if (input[key] !== undefined) {
        fields.push(`${key} = $${p++}`);
        params.push(input[key]);
      }
    }
    if (input.images !== undefined) {
      fields.push(`images = $${p++}`);
      params.push(JSON.stringify(input.images));
    }
    if (input.variants !== undefined) {
      fields.push(`variants = $${p++}`);
      params.push(JSON.stringify(input.variants));
    }
    if (fields.length === 0) throw new Error("No fields to update");

    if (input.name) {
      fields.push(`slug = $${p++}`);
      params.push(uniqueSlug(input.name, id));
    }

    params.push(id);
    const result = await db.query<Product>(
      `UPDATE products SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`,
      params
    );

    const updated = result.rows[0];
    invalidateProductCache(id, existing.slug);
    if (updated.slug !== existing.slug) cache.del(`products:slug:${updated.slug}`);
    return updated;
  },

  async delete(id: string): Promise<void> {
    // fetch first so we can bust slug cache too
    const product = await this.findById(id);
    const result = await db.query("DELETE FROM products WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundError("Product");
    invalidateProductCache(id, product.slug);
  },
};
