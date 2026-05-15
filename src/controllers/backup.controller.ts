import { Request, Response, NextFunction } from "express";
import fs   from "fs";
import path from "path";
import { db } from "../db";
import {
  runFullBackup,
  getActiveBackupId,
  resolveBackupFile,
  BackupRunSummary,
} from "../services/backup.service";
import { AppError } from "../utils/errors";

// ── GET /api/backups ──────────────────────────────────────────────────────
// List recent backup runs, newest first.

export async function listBackups(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);

    const { rows } = await db.query<BackupRunSummary>(
      `SELECT
         id, triggered_by, started_at, finished_at, status,
         db_file, db_size_bytes,
         products_file, products_count, products_size_bytes,
         error, retain_until
       FROM backup_runs
       ORDER BY started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = Number(
      (await db.query<{ count: string }>("SELECT COUNT(*) AS count FROM backup_runs")).rows[0].count
    );

    res.json({
      success: true,
      data:    rows,
      meta: {
        total,
        limit,
        offset,
        active_backup_id: getActiveBackupId(),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/backups/:id ──────────────────────────────────────────────────
// Get details of a single backup run.

export async function getBackup(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { rows } = await db.query<BackupRunSummary>(
      `SELECT
         id, triggered_by, started_at, finished_at, status,
         db_file, db_size_bytes,
         products_file, products_count, products_size_bytes,
         error, retain_until
       FROM backup_runs WHERE id = $1`,
      [req.params.id]
    );

    if (!rows[0]) throw new AppError("Backup run not found", 404, "NOT_FOUND");

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/backups/run ─────────────────────────────────────────────────
// Trigger a manual backup.

export async function triggerBackup(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const runId = await runFullBackup("manual");
    res.status(202).json({
      success:        true,
      message:        "Backup started — processing in background",
      backup_run_id:  runId,
    });
  } catch (err: any) {
    if (err?.message?.includes("already running")) {
      res.status(409).json({
        success:         false,
        error:           err.message,
        active_backup_id: getActiveBackupId(),
      });
      return;
    }
    next(err);
  }
}

// ── GET /api/backups/:id/download ─────────────────────────────────────────
// Stream a backup file back to the client.
// Query param: ?type=database|products

export async function downloadBackup(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const type = req.query.type as string;
    if (type !== "database" && type !== "products") {
      throw new AppError('Query param "type" must be "database" or "products"', 400, "VALIDATION");
    }

    const { rows } = await db.query<{
      db_file: string | null;
      products_file: string | null;
      status: string;
    }>(
      `SELECT db_file, products_file, status FROM backup_runs WHERE id = $1`,
      [req.params.id]
    );

    if (!rows[0]) throw new AppError("Backup run not found", 404, "NOT_FOUND");
    if (rows[0].status !== "completed") {
      throw new AppError(`Backup is ${rows[0].status} — file not available`, 409, "NOT_READY");
    }

    const relPath = type === "database" ? rows[0].db_file : rows[0].products_file;
    if (!relPath) throw new AppError("File not recorded for this backup run", 404, "NOT_FOUND");

    const absPath = resolveBackupFile(relPath);
    if (!fs.existsSync(absPath)) {
      throw new AppError("Backup file not found on disk", 404, "FILE_MISSING");
    }

    const fileName = path.basename(absPath);
    res.setHeader("Content-Type",        "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length",      fs.statSync(absPath).size);

    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    next(err);
  }
}
