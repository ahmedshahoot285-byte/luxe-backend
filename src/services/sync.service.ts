/**
 * Product Sync Service
 *
 * Responsibilities:
 *   1. Re-scrape every active product and update price + stock
 *   2. Detect products deleted from Sephora (404 / "not found") and deactivate
 *   3. Run automatically every day at 02:00 server time (no extra dependencies)
 *   4. Expose progress via sync_jobs + sync_logs tables so the admin UI can poll
 */

import { db } from "../db";
import { scrapeSephoraProduct } from "./scraper.service";
import { getPricingConfig, calculateLydPrice, detectCategory } from "./pricing.service";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SyncProductResult {
  product_id:   string;
  product_name: string;
  result:       "updated" | "unchanged" | "deleted" | "failed";
  changes?: {
    price_lyd_before?: number;
    price_lyd_after?:  number;
    stock_before?:     string;
    stock_after?:      string;
  };
  reason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function jitter(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

const INC_ALLOWED = new Set(["updated", "unchanged", "deleted", "failed"]);

/** Increment a counter column on a sync_jobs row (non-fatal) */
async function inc(syncJobId: string, col: string, by = 1) {
  if (!INC_ALLOWED.has(col)) {
    console.error(`inc(): rejected unknown column "${col}"`);
    return;
  }
  try {
    // col is validated against the allowlist above — safe to interpolate
    await db.query(
      `UPDATE sync_jobs SET ${col} = ${col} + $1 WHERE id = $2`,
      [by, syncJobId]
    );
  } catch {}
}

/** True if an error message indicates the product page is permanently gone */
function isDeletedError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("404") ||
    lower.includes("page not found") ||
    lower.includes("product not found") ||
    lower.includes("ürün bulunamadı") ||
    lower.includes("sayfa bulunamadı")
  );
}

// ── Single-product sync ───────────────────────────────────────────────────

export async function syncProduct(
  productId:  string,
  syncJobId:  string
): Promise<SyncProductResult> {
  // Load the product
  const prodRes = await db.query<{
    id:           string;
    name:         string;
    original_url: string | null;
    price_lyd:    number;
    stock_status: string;
  }>(
    `SELECT id, name, original_url, price_lyd, stock_status
     FROM products WHERE id = $1`,
    [productId]
  );

  const product = prodRes.rows[0];
  if (!product || !product.original_url) {
    return {
      product_id:   productId,
      product_name: product?.name ?? "Unknown",
      result:       "failed",
      reason:       "No original URL — skipping",
    };
  }

  let scraped;

  // ── Scrape ───────────────────────────────────────────────────────────────
  try {
    scraped = await scrapeSephoraProduct(product.original_url);
  } catch (err: any) {
    const msg     = err?.message ?? "Unknown scrape error";
    const deleted = isDeletedError(msg);

    if (deleted) {
      // Deactivate the product
      await db.query(
        `UPDATE products
         SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [productId]
      );
      await logSync(syncJobId, productId, product.name, "deleted", undefined, "Product no longer exists on Sephora");
      await inc(syncJobId, "deleted");
      return {
        product_id:   productId,
        product_name: product.name,
        result:       "deleted",
        reason:       msg,
      };
    }

    // Transient error (anti-bot block, timeout, etc.) — don't deactivate
    await logSync(syncJobId, productId, product.name, "failed", undefined, msg);
    await inc(syncJobId, "failed");
    return {
      product_id:   productId,
      product_name: product.name,
      result:       "failed",
      reason:       msg,
    };
  }

  // ── Compute new price ─────────────────────────────────────────────────────
  const category     = detectCategory(scraped.name, scraped.description);
  const config       = await getPricingConfig(category);
  const newPriceLyd  = calculateLydPrice(scraped.price_try, config);
  const newStock     = scraped.stock_status;

  const oldPriceLyd  = Number(product.price_lyd);
  const oldStock     = product.stock_status;

  const priceChanged = Math.abs(newPriceLyd - oldPriceLyd) >= 0.01;
  const stockChanged = newStock !== oldStock;

  if (!priceChanged && !stockChanged) {
    // Still update last_synced_at
    await db.query(
      "UPDATE products SET last_synced_at = NOW() WHERE id = $1",
      [productId]
    );
    await logSync(syncJobId, productId, product.name, "unchanged");
    await inc(syncJobId, "unchanged");
    return {
      product_id:   productId,
      product_name: product.name,
      result:       "unchanged",
    };
  }

  // ── Apply updates ─────────────────────────────────────────────────────────
  await db.query(
    `UPDATE products
     SET price_lyd      = $1,
         stock_status   = $2,
         last_synced_at = NOW(),
         updated_at     = NOW()
     WHERE id = $3`,
    [newPriceLyd, newStock, productId]
  );

  const changes = {
    ...(priceChanged ? { price_lyd_before: oldPriceLyd, price_lyd_after: newPriceLyd } : {}),
    ...(stockChanged ? { stock_before: oldStock,         stock_after: newStock         } : {}),
  };

  await logSync(syncJobId, productId, product.name, "updated", changes);
  await inc(syncJobId, "updated");

  return {
    product_id:   productId,
    product_name: product.name,
    result:       "updated",
    changes,
  };
}

async function logSync(
  syncJobId:  string,
  productId:  string,
  productName: string,
  result:     "updated" | "unchanged" | "deleted" | "failed",
  changes?:   object,
  errorMsg?:  string
) {
  try {
    await db.query(
      `INSERT INTO sync_logs
         (sync_job_id, product_id, product_name, result, changes, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [syncJobId, productId, productName, result, JSON.stringify(changes ?? {}), errorMsg ?? null]
    );
  } catch {}
}

// ── Full catalog sync ─────────────────────────────────────────────────────

const BATCH_SIZE     = 4;    // products scraped in parallel per wave
const BATCH_DELAY_MS = 8000; // pause between waves (anti-bot)

/** Key used to track a running sync so we don't start two at once */
let activeSyncJobId: string | null = null;

export function getActiveSyncJobId(): string | null {
  return activeSyncJobId;
}

export async function runFullSync(trigger: "manual" | "scheduled"): Promise<string> {
  if (activeSyncJobId) {
    throw new Error("A sync is already running — wait for it to complete");
  }

  // Hold the lock immediately (before the async DB call) to prevent race conditions
  // where two concurrent requests both pass the `activeSyncJobId` check above.
  activeSyncJobId = "__pending__";

  // Create sync_jobs row
  const jobRes = await db.query<{ id: string }>(
    `INSERT INTO sync_jobs (trigger, status) VALUES ($1, 'running') RETURNING id`,
    [trigger]
  );
  const syncJobId = jobRes.rows[0].id;
  activeSyncJobId = syncJobId;

  // Run async so the HTTP caller gets the ID immediately
  setImmediate(async () => {
    try {
      // Load all active products that have a Sephora URL
      const products = await db.query<{ id: string }>(
        `SELECT id FROM products
         WHERE is_active = TRUE AND original_url IS NOT NULL
         ORDER BY last_synced_at ASC NULLS FIRST`
      );

      const ids   = products.rows.map((r) => r.id);
      const total = ids.length;

      await db.query("UPDATE sync_jobs SET total = $1 WHERE id = $2", [total, syncJobId]);

      // Process in batches
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        // Check if the job was cancelled
        const check = await db.query<{ status: string }>(
          "SELECT status FROM sync_jobs WHERE id = $1",
          [syncJobId]
        );
        if (check.rows[0]?.status === "cancelled") break;

        const batch = ids.slice(i, i + BATCH_SIZE);

        // Run batch in parallel
        await Promise.allSettled(
          batch.map((id) => syncProduct(id, syncJobId))
        );

        // Delay between batches (skip after the last one)
        if (i + BATCH_SIZE < ids.length) {
          await jitter(BATCH_DELAY_MS, BATCH_DELAY_MS + 3000);
        }
      }

      await db.query(
        `UPDATE sync_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [syncJobId]
      );

      // Persist last sync time in settings
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('last_sync_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [new Date().toISOString()]
      );
    } catch (err: any) {
      await db.query(
        `UPDATE sync_jobs
         SET status = 'failed', completed_at = NOW(), error_message = $1
         WHERE id = $2`,
        [err?.message ?? "Unknown error", syncJobId]
      );
    } finally {
      activeSyncJobId = null;
    }
  });

  return syncJobId;
}

// ── Cancel a running sync ─────────────────────────────────────────────────

export async function cancelSync(syncJobId: string): Promise<void> {
  await db.query(
    `UPDATE sync_jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
    [syncJobId]
  );
  if (activeSyncJobId === syncJobId) {
    activeSyncJobId = null;
  }
}

// ── Daily scheduler ───────────────────────────────────────────────────────
// No external dependencies — uses a simple recursive setTimeout.
// Runs at 02:00 server time every day.

const SYNC_HOUR   = 2;   // 2 AM
const SYNC_MINUTE = 0;

function msUntilNextSync(): number {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + (
    now.getHours() >= SYNC_HOUR ? 1 : 0  // if already past 2am, schedule tomorrow
  ));
  next.setHours(SYNC_HOUR, SYNC_MINUTE, 0, 0);
  return next.getTime() - now.getTime();
}

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

export function startSyncScheduler(): void {
  const scheduleNext = () => {
    const delay  = msUntilNextSync();
    const runsAt = new Date(Date.now() + delay);
    console.log(`⏰ Next auto-sync scheduled at ${runsAt.toLocaleString()}`);

    schedulerTimer = setTimeout(async () => {
      schedulerTimer = null;
      console.log("🔄 Running scheduled daily sync…");
      try {
        const jobId = await runFullSync("scheduled");
        console.log(`✓ Sync started (job ${jobId})`);
      } catch (err: any) {
        console.error("✗ Scheduled sync failed to start:", err?.message);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

/** Stop the scheduler — call during graceful shutdown so the timer can't
 *  fire after the DB pool has been closed. */
export function stopSyncScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
