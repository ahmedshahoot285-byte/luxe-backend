import { db } from "../db";
import { scrapeSephoraProduct, ScrapedProduct } from "./scraper.service";
import { getPricingConfig, calculateLydPrice, detectCategory } from "./pricing.service";
import { validateImages, normalizeUrl } from "./validator.service";
import { slugify, uniqueSlug } from "../utils/slugify";

export type ImportResult =
  | { status: "completed"; product_id: string; product_name: string }
  | { status: "updated";   product_id: string; product_name: string }
  | { status: "skipped";   product_id: string; reason: string }
  | { status: "failed";    reason: string };

// ── Clean slug resolution ─────────────────────────────────────────────────
// Try the plain slug first; fall back to slug-{8-char-uuid} only on conflict.

async function resolveSlug(
  name: string,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { cnt: string }[] }> }
): Promise<string> {
  const base = slugify(name);
  const check = await client.query(
    `SELECT COUNT(*) AS cnt FROM products WHERE slug = $1`,
    [base]
  );
  if (parseInt(check.rows[0].cnt, 10) === 0) return base;
  // Collision — append first 8 chars of a fresh UUID
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

// ── Log helper ────────────────────────────────────────────────────────────

async function log(
  type: string,
  level: string,
  message: string,
  metadata?: object
) {
  try {
    await db.query(
      `INSERT INTO logs (type, level, message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [type, level, message, JSON.stringify(metadata ?? {})]
    );
  } catch {}
}

// ── Update import_urls row ────────────────────────────────────────────────
// Explicit named columns — NO dynamic interpolation (prevents SQL injection).

interface ImportStatusExtra {
  error_message?: string;
  product_id?:    string;
  scraped_data?:  unknown;
  completed_at?:  boolean;
}

async function setImportStatus(
  importId: string,
  status: string,
  extra: ImportStatusExtra = {}
) {
  await db.query(
    `UPDATE import_urls
     SET status            = $1,
         last_attempted_at = NOW(),
         attempt_count     = attempt_count + 1,
         error_message     = COALESCE($2, error_message),
         product_id        = COALESCE($3::uuid, product_id),
         scraped_data      = COALESCE($4::jsonb, scraped_data),
         completed_at      = CASE WHEN $5 THEN NOW() ELSE completed_at END
     WHERE id = $6`,
    [
      status,
      extra.error_message ?? null,
      extra.product_id    ?? null,
      extra.scraped_data  != null ? JSON.stringify(extra.scraped_data) : null,
      extra.completed_at  ?? false,
      importId,
    ]
  );
}

// ── Main import function ──────────────────────────────────────────────────

export async function importFromUrl(
  url: string,
  importId: string
): Promise<ImportResult> {
  // Normalize URL once so all DB checks are consistent
  const normalizedUrl = normalizeUrl(url);

  // Mark as processing
  await setImportStatus(importId, "processing");

  let scraped: ScrapedProduct;

  // ── 1. Scrape ────────────────────────────────────────────────────────────
  try {
    scraped = await scrapeSephoraProduct(normalizedUrl);
    await log("import", "info", `Scraped: ${scraped.name}`, { url: normalizedUrl, importId });
  } catch (err: any) {
    const reason = err.message ?? "Unknown scrape error";
    await setImportStatus(importId, "failed", { error_message: reason });
    await log("import", "error", `Scrape failed: ${reason}`, { url: normalizedUrl, importId });
    return { status: "failed", reason };
  }

  // ── 1b. Validate images ───────────────────────────────────────────────────
  const imgCheck = validateImages(scraped.images);
  if (!imgCheck.valid) {
    const reason = imgCheck.issues.map((i) => i.message).join("; ");
    await setImportStatus(importId, "failed", { error_message: reason });
    await log("import", "error", `Image validation failed: ${reason}`, { url: normalizedUrl, importId });
    return { status: "failed", reason };
  }
  if (imgCheck.issues.length > 0) {
    await log("import", "warn", `Image warnings: ${imgCheck.issues.map(i => i.message).join("; ")}`, { url: normalizedUrl });
  }

  // ── 2. Check duplicate (by normalized URL or SKU) ────────────────────────
  const existing = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM products
     WHERE original_url = $1
        OR (sephora_sku IS NOT NULL AND sephora_sku = $2)
     LIMIT 1`,
    [normalizedUrl, scraped.sku ?? null]
  );

  if (existing.rows[0]) {
    // Product exists — update stock + price only
    const existingProduct = existing.rows[0];
    const category = detectCategory(scraped.name, scraped.description);
    const config   = await getPricingConfig(category);
    const price    = calculateLydPrice(scraped.price_try, config);

    await db.query(
      `UPDATE products
       SET price_lyd      = $1,
           stock_status   = $2,
           last_synced_at = NOW(),
           updated_at     = NOW()
       WHERE id = $3`,
      [price, scraped.stock_status, existingProduct.id]
    );

    await setImportStatus(importId, "updated", {
      product_id:   existingProduct.id,
      scraped_data: scraped,
      completed_at: true,
    });

    await log("import", "info", `Updated existing product: ${existingProduct.name}`, {
      product_id: existingProduct.id,
      importId,
    });

    return {
      status:       "updated",
      product_id:   existingProduct.id,
      product_name: existingProduct.name,
    };
  }

  // ── 3. Resolve brand ─────────────────────────────────────────────────────
  let brand_id: string | null = null;
  if (scraped.brand) {
    const brandSlug = slugify(scraped.brand);
    const brandRes = await db.query<{ id: string }>(
      `INSERT INTO brands (name, slug)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [scraped.brand, brandSlug]
    );
    brand_id = brandRes.rows[0]?.id ?? null;
  }

  // ── 4. Pricing ───────────────────────────────────────────────────────────
  const category = detectCategory(scraped.name, scraped.description);
  const config   = await getPricingConfig(category);
  const price    = calculateLydPrice(scraped.price_try, config);

  // Apply pricing to variants too
  const variants = scraped.variants.map((v) => ({
    ...v,
    price_lyd: v.price_try > 0
      ? calculateLydPrice(v.price_try, config)
      : price,
  }));

  // ── 5. Save product ──────────────────────────────────────────────────────
  const product = await db.transaction(async (client) => {
    // Let PostgreSQL generate the UUID so we avoid an extra round-trip
    const images = scraped.images.map((url, i) => ({
      url,
      alt: `${scraped.name} - view ${i + 1}`,
    }));

    const res = await client.query<{ id: string; name: string }>(
      `INSERT INTO products (
         slug, name, description,
         brand_id, price_lyd,
         images, variants,
         stock_status, stock_qty,
         original_url, sephora_sku,
         is_new, last_synced_at
       ) VALUES (
         $1,  $2,  $3,
         $4,  $5,
         $6,  $7,
         $8,  $9,
         $10, $11,
         TRUE, NOW()
       ) RETURNING id, name`,
      [
        await resolveSlug(scraped.name, client),
        scraped.name,
        scraped.description || null,
        brand_id,
        price,
        JSON.stringify(images),
        JSON.stringify(variants),
        scraped.stock_status,
        scraped.variants.reduce((s, v) => s + v.stock, 0) || 10,
        normalizedUrl,
        scraped.sku || null,
      ]
    );

    return res.rows[0];
  });

  // ── 6. Mark import done ──────────────────────────────────────────────────
  await setImportStatus(importId, "completed", {
    product_id:   product.id,
    scraped_data: scraped,
    completed_at: true,
  });

  await log("import", "info", `Imported: ${product.name}`, {
    product_id: product.id,
    price_lyd:  price,
    category,
    importId,
  });

  return {
    status:       "completed",
    product_id:   product.id,
    product_name: product.name,
  };
}
