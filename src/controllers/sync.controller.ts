import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import {
  runFullSync,
  syncProduct,
  cancelSync,
  getActiveSyncJobId,
} from "../services/sync.service";
import { AppError } from "../utils/errors";

// ── POST /api/sync/run ────────────────────────────────────────────────────
// Start a full catalog sync (manual trigger).

export async function triggerSync(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const jobId = await runFullSync("manual");
    res.status(202).json({
      success: true,
      message: "Sync started — processing in background",
      sync_job_id: jobId,
    });
  } catch (err: any) {
    // If a sync is already running, return 409
    if (err?.message?.includes("already running")) {
      res.status(409).json({
        success:     false,
        error:       err.message,
        sync_job_id: getActiveSyncJobId(),
      });
      return;
    }
    next(err);
  }
}

// ── POST /api/sync/cancel ─────────────────────────────────────────────────
// Cancel a running sync job.

export async function cancelSyncJob(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const job = await db.query<{ status: string }>(
      "SELECT status FROM sync_jobs WHERE id = $1",
      [id]
    );
    if (!job.rows[0]) throw new AppError("Sync job not found", 404, "NOT_FOUND");
    if (job.rows[0].status !== "running") {
      res.status(400).json({ success: false, error: "Job is not running" });
      return;
    }
    await cancelSync(id);
    res.json({ success: true, message: "Sync job cancelled" });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/sync/product/:id ────────────────────────────────────────────
// Manually re-sync a single product.

export async function syncOneProduct(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Create a throwaway sync_jobs row for this one-off sync
    const jobRes = await db.query<{ id: string }>(
      `INSERT INTO sync_jobs (trigger, status, total)
       VALUES ('manual', 'running', 1)
       RETURNING id`,
    );
    const syncJobId = jobRes.rows[0].id;

    // Run inline — single product is fast enough
    const result = await syncProduct(id, syncJobId);

    await db.query(
      `UPDATE sync_jobs
       SET status = 'completed', completed_at = NOW(),
           updated   = $1,
           unchanged = $2,
           deleted   = $3,
           failed    = $4
       WHERE id = $5`,
      [
        result.result === "updated"   ? 1 : 0,
        result.result === "unchanged" ? 1 : 0,
        result.result === "deleted"   ? 1 : 0,
        result.result === "failed"    ? 1 : 0,
        syncJobId,
      ]
    );

    res.json({
      success:     true,
      sync_job_id: syncJobId,
      result,
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/sync/status ──────────────────────────────────────────────────
// Current running sync (if any) + last completed.

export async function getSyncStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const activeId = getActiveSyncJobId();

    const jobs = await db.query(
      `SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 10`
    );

    const lastSyncSetting = await db.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'last_sync_at'"
    );

    res.json({
      success:    true,
      active_job: activeId,
      last_sync:  lastSyncSetting.rows[0]?.value ?? null,
      jobs:       jobs.rows,
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/sync/:id ─────────────────────────────────────────────────────
// Detailed status + logs for a specific sync job.

export async function getSyncJob(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const job = await db.query(
      "SELECT * FROM sync_jobs WHERE id = $1",
      [id]
    );
    if (!job.rows[0]) throw new AppError("Sync job not found", 404, "NOT_FOUND");

    const logs = await db.query(
      `SELECT * FROM sync_logs WHERE sync_job_id = $1 ORDER BY synced_at DESC`,
      [id]
    );

    res.json({
      success: true,
      data:    { ...job.rows[0], logs: logs.rows },
    });
  } catch (err) {
    next(err);
  }
}
