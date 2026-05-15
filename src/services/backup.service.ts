/**
 * Backup Service
 *
 * Responsibilities:
 *   1. Products backup — exports every active product (full JSONB data) to a
 *      timestamped JSON file so the catalogue can be restored without a DB dump.
 *   2. Database backup — exports all key operational tables (products, orders,
 *      brands, categories, settings, import_urls) as a single JSON snapshot.
 *   3. Scheduler — fires once daily at 03:00 server time using recursive
 *      setTimeout (same pattern as the sync scheduler, no cron dependency).
 *   4. Retention — deletes backup files and DB rows older than BACKUP_RETAIN_DAYS
 *      (default 30) after every successful run.
 */

import fs   from "fs";
import path from "path";
import { db } from "../db";

// ── Config ────────────────────────────────────────────────────────────────

const BACKUP_DIR    = process.env.BACKUP_DIR
  ?? path.join(process.cwd(), "backups");

const RETAIN_DAYS   = Math.max(1, Number(process.env.BACKUP_RETAIN_DAYS ?? 30));

// ── Types ─────────────────────────────────────────────────────────────────

export interface BackupRunSummary {
  id:                  string;
  triggered_by:        string;
  started_at:          string;
  finished_at:         string | null;
  status:              "running" | "completed" | "failed";
  db_file:             string | null;
  db_size_bytes:       number | null;
  products_file:       string | null;
  products_count:      number | null;
  products_size_bytes: number | null;
  error:               string | null;
  retain_until:        string;
}

// ── Concurrency guard ─────────────────────────────────────────────────────

let runningBackupId: string | null = null;

export function getActiveBackupId(): string | null {
  return runningBackupId;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** ISO timestamp safe for use in file names (colons replaced with dashes). */
function fileTs(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T");
}

function fileSize(filePath: string): number {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

/** Resolve a stored relative path back to an absolute path on disk. */
export function resolveBackupFile(relative: string): string {
  // Normalise and prevent directory traversal
  const normalised = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(BACKUP_DIR, normalised);
}

// ── Products backup ───────────────────────────────────────────────────────

async function backupProducts(runId: string): Promise<{
  file: string; count: number; sizeBytes: number;
}> {
  const dir = path.join(BACKUP_DIR, "products");
  ensureDir(dir);

  const ts       = fileTs();
  const fileName = `products-${ts}.json`;
  const filePath = path.join(dir, fileName);
  const relative = path.join("products", fileName);

  const { rows } = await db.query(`
    SELECT
      p.id,
      p.slug,
      p.name,
      p.price_lyd,
      p.stock_status,
      p.stock_qty,
      p.is_active,
      p.is_new,
      p.is_featured,
      p.images,
      p.original_url,
      p.sephora_sku,
      p.last_synced_at,
      p.created_at,
      p.updated_at,
      b.name  AS brand_name,
      c.name  AS category_name,
      c.slug  AS category_slug
    FROM      products  p
    LEFT JOIN brands    b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY  p.created_at DESC
  `);

  const payload = {
    exported_at:   new Date().toISOString(),
    backup_run_id: runId,
    count:         rows.length,
    products:      rows,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

  return { file: relative, count: rows.length, sizeBytes: fileSize(filePath) };
}

// ── Database backup ───────────────────────────────────────────────────────

/** Tables exported in the database snapshot, in dependency order. */
const DB_TABLES = [
  "brands",
  "categories",
  "products",
  "orders",
  "order_items",
  "settings",
  "import_urls",
  "sync_jobs",
  "backup_runs",
] as const;

async function backupDatabase(runId: string): Promise<{
  file: string; sizeBytes: number;
}> {
  const dir = path.join(BACKUP_DIR, "database");
  ensureDir(dir);

  const ts       = fileTs();
  const fileName = `database-${ts}.json`;
  const filePath = path.join(dir, fileName);
  const relative = path.join("database", fileName);

  const snapshot: Record<string, unknown[]> = {};

  for (const table of DB_TABLES) {
    try {
      const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY created_at DESC NULLS LAST`);
      snapshot[table] = rows;
    } catch {
      // Table might not exist yet — skip gracefully
      snapshot[table] = [];
    }
  }

  const payload = {
    exported_at:    new Date().toISOString(),
    backup_run_id:  runId,
    postgres_version: (await db.query("SELECT version()")).rows[0]?.version ?? "unknown",
    tables:         snapshot,
    row_counts:     Object.fromEntries(
      Object.entries(snapshot).map(([t, rows]) => [t, rows.length])
    ),
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

  return { file: relative, sizeBytes: fileSize(filePath) };
}

// ── Retention cleanup ─────────────────────────────────────────────────────

async function cleanOldBackups(): Promise<void> {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000);

  // Fetch expired run file paths before deleting the rows
  const { rows } = await db.query<{
    db_file: string | null;
    products_file: string | null;
  }>(
    `SELECT db_file, products_file FROM backup_runs WHERE retain_until < $1`,
    [cutoff]
  );

  for (const row of rows) {
    for (const rel of [row.db_file, row.products_file]) {
      if (!rel) continue;
      try { fs.unlinkSync(resolveBackupFile(rel)); } catch { /* already gone */ }
    }
  }

  await db.query(
    `DELETE FROM backup_runs WHERE retain_until < $1`,
    [cutoff]
  );

  if (rows.length > 0) {
    console.log(`[backup] Cleaned ${rows.length} expired backup(s) (older than ${RETAIN_DAYS}d)`);
  }
}

// ── Full backup run ───────────────────────────────────────────────────────

export async function runFullBackup(
  triggeredBy: "scheduler" | "manual" = "scheduler"
): Promise<string> {
  if (runningBackupId) {
    throw new Error(`Backup already running (id: ${runningBackupId})`);
  }

  // Create the run record
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backup_runs (triggered_by, status)
     VALUES ($1, 'running')
     RETURNING id`,
    [triggeredBy]
  );
  const runId = rows[0].id;
  runningBackupId = runId;

  // Run both backups in background so the HTTP response can return immediately
  setImmediate(async () => {
    const updates: Record<string, unknown> = {};

    try {
      console.log(`[backup] Starting full backup (id: ${runId}, trigger: ${triggeredBy})`);

      const [dbResult, productsResult] = await Promise.all([
        backupDatabase(runId),
        backupProducts(runId),
      ]);

      updates.db_file             = dbResult.file;
      updates.db_size_bytes       = dbResult.sizeBytes;
      updates.products_file       = productsResult.file;
      updates.products_count      = productsResult.count;
      updates.products_size_bytes = productsResult.sizeBytes;
      updates.status              = "completed";
      updates.finished_at         = new Date();

      console.log(
        `[backup] Completed — DB: ${(dbResult.sizeBytes / 1024).toFixed(1)} KB, ` +
        `Products: ${productsResult.count} rows (${(productsResult.sizeBytes / 1024).toFixed(1)} KB)`
      );

      // Cleanup expired runs after a successful backup
      await cleanOldBackups();
    } catch (err: any) {
      updates.status      = "failed";
      updates.finished_at = new Date();
      updates.error       = err?.message ?? "Unknown error";
      console.error(`[backup] Failed:`, err?.message);
    } finally {
      runningBackupId = null;

      await db.query(
        `UPDATE backup_runs
         SET status              = $1,
             finished_at         = $2,
             db_file             = $3,
             db_size_bytes       = $4,
             products_file       = $5,
             products_count      = $6,
             products_size_bytes = $7,
             error               = $8
         WHERE id = $9`,
        [
          updates.status,
          updates.finished_at ?? null,
          updates.db_file             ?? null,
          updates.db_size_bytes       ?? null,
          updates.products_file       ?? null,
          updates.products_count      ?? null,
          updates.products_size_bytes ?? null,
          updates.error               ?? null,
          runId,
        ]
      );
    }
  });

  return runId;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

/** Milliseconds until the next 03:00 (local server time). */
function msUntilNextRun(): number {
  const now   = new Date();
  const next  = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * On startup: mark any "running" records older than 10 minutes as failed.
 * These are orphaned by a previous server crash or nodemon restart.
 */
export async function recoverStaleBackups(): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE backup_runs
     SET status      = 'failed',
         finished_at = NOW(),
         error       = 'Server restarted while backup was running'
     WHERE status = 'running'
       AND started_at < NOW() - INTERVAL '10 minutes'`
  );
  if ((rowCount ?? 0) > 0) {
    console.log(`[backup] Recovered ${rowCount} stale backup run(s) → marked as failed`);
  }
}

export function startBackupScheduler(): void {
  const schedule = () => {
    const delay = msUntilNextRun();
    const h     = Math.floor(delay / 3_600_000);
    const m     = Math.floor((delay % 3_600_000) / 60_000);
    console.log(`[backup] Next backup in ${h}h ${m}m (03:00 daily)`);

    schedulerTimer = setTimeout(async () => {
      try {
        await runFullBackup("scheduler");
      } catch (err: any) {
        console.error("[backup] Scheduler error:", err?.message);
      }
      schedule(); // reschedule after each run
    }, delay);
  };

  schedule();
}

export function stopBackupScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
