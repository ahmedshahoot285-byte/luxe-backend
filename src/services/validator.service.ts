import { db } from "../db";

// ── Types ──────────────────────────────────────────────────────────────────

export type ValidationLevel = "error" | "warning" | "info";

export interface ValidationIssue {
  code:    string;
  level:   ValidationLevel;
  message: string;
  detail?: string;
}

export interface UrlValidationResult {
  valid:          boolean;        // false = hard block, don't import
  normalized_url: string;         // cleaned URL to use for the actual import
  issues:         ValidationIssue[];
  duplicate?:     DuplicateMatch;
}

export interface DuplicateMatch {
  product_id:   string;
  product_name: string;
  match_type:   "url" | "sku" | "name";
  import_status?: string;         // status from import_urls if it exists
}

export interface ImageValidationResult {
  valid:         boolean;
  image_count:   number;
  issues:        ValidationIssue[];
}

export interface ProductHealthReport {
  product_id:   string;
  product_name: string;
  price_lyd:    number;
  issues:       ValidationIssue[];
}

// ── Allowed Sephora domains ────────────────────────────────────────────────

const ALLOWED_HOSTS = [
  "www.sephora.com.tr",
  "sephora.com.tr",
];

// Product page paths must match one of these patterns:
//   /p/product-name/SKU12345       (standard product)
//   /urun/product-name             (alt format)
const PRODUCT_PATH_RE = /\/(p|urun)\//i;

// Known non-product paths (category/search pages)
const NON_PRODUCT_RE = /\/(c|brands|search|kampanya|yeni-urunler|en-cok-satanlar|hediye|skin-quiz)\b/i;

// Tracking / noise params to strip
const STRIP_PARAMS = [
  "utm_source","utm_medium","utm_campaign","utm_content","utm_term",
  "gclid","fbclid","msclkid","ref","src","source","affiliate",
  "cm_mmc","icid","skuId",
];

// ── URL normaliser ─────────────────────────────────────────────────────────

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());

    // Force https
    u.protocol = "https:";

    // Remove trailing slash
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // Strip tracking params
    for (const p of STRIP_PARAMS) u.searchParams.delete(p);

    // Remove fragment
    u.hash = "";

    return u.toString();
  } catch {
    return raw.trim();
  }
}

// ── URL validator ─────────────────────────────────────────────────────────

export interface ValidateImportOptions {
  /**
   * If true, skip the product-path check so category/brand URLs pass
   * validation (used by the catalog bulk-import endpoint).
   */
  allowCategory?: boolean;
}

export async function validateImportUrl(
  rawUrl: string,
  opts: ValidateImportOptions = {}
): Promise<UrlValidationResult> {
  const issues: ValidationIssue[] = [];
  let parsed: URL;

  // ── 1. Parseable? ─────────────────────────────────────────────────────────
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      valid: false,
      normalized_url: rawUrl,
      issues: [{
        code:    "URL_INVALID",
        level:   "error",
        message: "Not a valid URL",
        detail:  "Make sure the URL starts with https://",
      }],
    };
  }

  const normalized = normalizeUrl(rawUrl);

  // ── 2. Correct domain? ────────────────────────────────────────────────────
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return {
      valid: false,
      normalized_url: normalized,
      issues: [{
        code:    "WRONG_DOMAIN",
        level:   "error",
        message: `Domain must be sephora.com.tr — got "${parsed.hostname}"`,
        detail:  "Only Sephora Turkey product URLs are supported.",
      }],
    };
  }

  // ── 3. Product page pattern (skip when allowCategory is set) ─────────────
  if (!opts.allowCategory) {
    if (NON_PRODUCT_RE.test(parsed.pathname)) {
      issues.push({
        code:    "NOT_PRODUCT_PAGE",
        level:   "error",
        message: "This looks like a category or search page, not a product",
        detail:  "Navigate to a specific product page and copy that URL.",
      });
    } else if (!PRODUCT_PATH_RE.test(parsed.pathname)) {
      issues.push({
        code:    "UNRECOGNIZED_PATH",
        level:   "warning",
        message: "URL path doesn't match the expected product pattern (/p/...)",
        detail:  "The import may still work but the page structure might differ.",
      });
    }
  }

  // ── 4. Hard-block on non-product errors ───────────────────────────────────
  const hasError = issues.some((i) => i.level === "error");
  if (hasError) {
    return { valid: false, normalized_url: normalized, issues };
  }

  // ── 5. Duplicate detection ────────────────────────────────────────────────

  // 5a. Exact normalized URL in import_urls
  const importMatch = await db.query<{
    id: string; status: string; product_id: string | null;
  }>(
    "SELECT id, status, product_id FROM import_urls WHERE url = $1",
    [normalized]
  ).catch(() => ({ rows: [] as any[] }));

  // 5b. Product with matching original_url
  const urlMatch = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM products WHERE original_url = $1",
    [normalized]
  ).catch(() => ({ rows: [] as any[] }));

  if (urlMatch.rows[0]) {
    return {
      valid:          false,
      normalized_url: normalized,
      issues: [{
        code:    "DUPLICATE_URL",
        level:   "error",
        message: `Product already exists: "${urlMatch.rows[0].name}"`,
        detail:  "Use the re-sync option on the existing product to update price/stock.",
      }],
      duplicate: {
        product_id:   urlMatch.rows[0].id,
        product_name: urlMatch.rows[0].name,
        match_type:   "url",
        import_status: importMatch.rows[0]?.status,
      },
    };
  }

  // 5c. Import in progress (queued/processing)
  if (importMatch.rows[0]) {
    const { status } = importMatch.rows[0];
    if (status === "queued" || status === "processing") {
      issues.push({
        code:    "IMPORT_IN_PROGRESS",
        level:   "error",
        message: `This URL is already being imported (status: ${status})`,
      });
      return { valid: false, normalized_url: normalized, issues };
    }
    // Previously failed — allow retry, just warn
    if (status === "failed") {
      issues.push({
        code:    "PREVIOUS_FAILURE",
        level:   "warning",
        message: "This URL was previously imported but failed — will retry",
      });
    }
  }

  // 5d. Extract SKU from URL path for SKU-based duplicate check
  //     Sephora product URLs end with /P-XXXXXXXX or a numeric SKU
  const skuMatch = parsed.pathname.match(/[\/\-]([A-Z0-9]{6,12})(?:\/|$)/i);
  if (skuMatch) {
    const sku = skuMatch[1].toUpperCase();
    const skuRes = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM products WHERE sephora_sku = $1",
      [sku]
    ).catch(() => ({ rows: [] as any[] }));

    if (skuRes.rows[0]) {
      return {
        valid:          false,
        normalized_url: normalized,
        issues: [{
          code:    "DUPLICATE_SKU",
          level:   "error",
          message: `Product with SKU "${sku}" already exists: "${skuRes.rows[0].name}"`,
        }],
        duplicate: {
          product_id:   skuRes.rows[0].id,
          product_name: skuRes.rows[0].name,
          match_type:   "sku",
        },
      };
    }
  }

  // All checks passed
  return {
    valid:          true,
    normalized_url: normalized,
    issues,  // may contain warnings
  };
}

// ── Image validator (called after scraping) ───────────────────────────────

export function validateImages(images: string[]): ImageValidationResult {
  const issues: ValidationIssue[] = [];

  if (!images || images.length === 0) {
    issues.push({
      code:    "NO_IMAGES",
      level:   "error",
      message: "No images were scraped — product cannot be imported without at least one image",
    });
    return { valid: false, image_count: 0, issues };
  }

  // Check each URL is absolute
  const relativeImages = images.filter(
    (url) => !url.startsWith("http://") && !url.startsWith("https://")
  );
  if (relativeImages.length > 0) {
    issues.push({
      code:    "RELATIVE_IMAGE_URLS",
      level:   "error",
      message: `${relativeImages.length} image(s) have relative paths and cannot be saved`,
      detail:  relativeImages.slice(0, 2).join(", "),
    });
    // Filter them out — if all are bad, block
    const goodImages = images.filter(
      (url) => url.startsWith("http://") || url.startsWith("https://")
    );
    if (goodImages.length === 0) {
      return { valid: false, image_count: 0, issues };
    }
  }

  // Warn if fewer than 2 images (not a hard block)
  if (images.length === 1) {
    issues.push({
      code:    "SINGLE_IMAGE",
      level:   "warning",
      message: "Only 1 image found — product will have limited gallery",
    });
  }

  // Warn on suspiciously small number for a beauty product
  if (images.length >= 2 && images.length < 3) {
    issues.push({
      code:    "FEW_IMAGES",
      level:   "info",
      message: `${images.length} images scraped`,
    });
  }

  return {
    valid:       issues.every((i) => i.level !== "error"),
    image_count: images.length,
    issues,
  };
}

// ── Product health audit ──────────────────────────────────────────────────
// Returns products that have data quality issues.

export async function auditProductHealth(): Promise<ProductHealthReport[]> {
  const rows = await db.query<{
    id:          string;
    name:        string;
    price_lyd:   number;
    images:      unknown;
    description: string | null;
    stock_qty:   number;
    is_active:   boolean;
  }>(
    `SELECT id, name, price_lyd, images, description, stock_qty, is_active
     FROM products
     WHERE is_active = TRUE
     ORDER BY created_at DESC`
  );

  const reports: ProductHealthReport[] = [];

  for (const row of rows.rows) {
    const issues: ValidationIssue[] = [];

    // Image check
    let images: string[] = [];
    try {
      const raw = row.images;
      const arr = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
      images = arr.map((img: { url?: string } | string) =>
        typeof img === "string" ? img : img?.url ?? ""
      ).filter(Boolean);
    } catch {}

    if (images.length === 0) {
      issues.push({ code: "NO_IMAGES", level: "error", message: "No product images" });
    } else if (images.length === 1) {
      issues.push({ code: "SINGLE_IMAGE", level: "warning", message: "Only 1 image" });
    }

    // Description check
    if (!row.description || row.description.trim().length < 20) {
      issues.push({
        code:    "MISSING_DESCRIPTION",
        level:   "warning",
        message: "Missing or very short description",
      });
    }

    // Price check
    if (!row.price_lyd || Number(row.price_lyd) <= 0) {
      issues.push({ code: "ZERO_PRICE", level: "error", message: "Price is 0 or missing" });
    }

    // Stock check
    if (row.stock_qty === 0) {
      issues.push({ code: "ZERO_STOCK", level: "warning", message: "Stock quantity is 0" });
    }

    if (issues.length > 0) {
      reports.push({
        product_id:   row.id,
        product_name: row.name,
        price_lyd:    Number(row.price_lyd),
        issues,
      });
    }
  }

  return reports;
}
