import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { validateSephoraUrl, scrapeSephoraCatalog } from "../services/scraper.service";
import { importFromUrl } from "../services/importer.service";
import { enqueueImport } from "../services/queue.service";
import { validateImportUrl, auditProductHealth, normalizeUrl } from "../services/validator.service";
import { AppError } from "../utils/errors";

// ── POST /api/import ───────────────────────────────────────────────────────
// Accepts a Sephora Turkey URL, creates an import_urls record,
// then either queues the job (Redis available) or runs inline.

export async function startImport(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { url } = req.body as { url: string };

    // ── Full validation (domain, path, duplicate detection) ────────────────
    const validation = await validateImportUrl(url);

    if (!validation.valid) {
      const hardError = validation.issues.find((i) => i.level === "error");
      res.status(422).json({
        success:    false,
        error:      hardError?.message ?? "URL validation failed",
        code:       hardError?.code,
        issues:     validation.issues,
        duplicate:  validation.duplicate ?? null,
      });
      return;
    }

    // Use normalized URL for all subsequent operations
    const cleanUrl = validation.normalized_url;

    // Check if URL already exists in import queue
    const existing = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM import_urls WHERE url = $1",
      [cleanUrl]
    );

    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.status === "processing" || row.status === "queued") {
        res.status(409).json({
          success:   false,
          error:     "This URL is already being imported",
          import_id: row.id,
        });
        return;
      }
      // Allow re-import if previously failed or completed (re-sync)
      await db.query(
        `UPDATE import_urls
         SET status = 'queued', error_message = NULL, job_id = NULL
         WHERE id = $1`,
        [row.id]
      );
      await runImport(cleanUrl, row.id, res, next);
      return;
    }

    // Create new import record
    const importRes = await db.query<{ id: string }>(
      `INSERT INTO import_urls (url, status)
       VALUES ($1, 'queued')
       RETURNING id`,
      [cleanUrl]
    );
    const importId = importRes.rows[0].id;

    await runImport(cleanUrl, importId, res, next);
  } catch (err) {
    next(err);
  }
}

async function runImport(
  url: string,
  importId: string,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Try queue first
    const jobId = await enqueueImport({ url, importId });

    if (jobId) {
      // Update record with job ID
      await db.query(
        "UPDATE import_urls SET job_id = $1 WHERE id = $2",
        [jobId, importId]
      );

      res.status(202).json({
        success:   true,
        message:   "Import queued — processing in background",
        import_id: importId,
        job_id:    jobId,
      });
      return;
    }

    // No Redis — respond immediately, run import in background so the HTTP
    // request doesn't hang for 10-20s while Playwright scrapes.
    res.status(202).json({
      success:   true,
      message:   "Import started — processing in background",
      import_id: importId,
    });

    // Fire-and-forget (errors are recorded on the import_urls row)
    setImmediate(() => {
      importFromUrl(url, importId).catch((err) => {
        console.error(`[import] background job failed for ${importId}:`, err?.message);
      });
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/import/:id ────────────────────────────────────────────────────
// Poll import job status

export async function getImportStatus(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await db.query(
      `SELECT
         i.id, i.url, i.status, i.error_message,
         i.attempt_count, i.last_attempted_at, i.completed_at,
         i.job_id,
         p.id   AS product_id,
         p.name AS product_name,
         p.slug AS product_slug,
         p.price_lyd
       FROM import_urls i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.id = $1`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      throw new AppError("Import job not found", 404, "NOT_FOUND");
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/import ────────────────────────────────────────────────────────
// List all import jobs (admin)

export async function listImports(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const page  = Number(req.query.page  ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where  = status ? "WHERE i.status = $3" : "";
    const params: unknown[] = [limit, offset];
    if (status) params.push(status);

    const rows = await db.query<{
      id:            string;
      url:           string;
      status:        string;
      error_message: string | null;
      attempt_count: number;
      created_at:    string;
      completed_at:  string | null;
      product_name:  string | null;
      product_id:    string | null;
      total_count:   string;
    }>(
      `SELECT
         i.id, i.url, i.status, i.error_message,
         i.attempt_count, i.created_at, i.completed_at,
         p.name AS product_name,
         p.id   AS product_id,
         COUNT(*) OVER() AS total_count
       FROM import_urls i
       LEFT JOIN products p ON p.id = i.product_id
       ${where}
       ORDER BY i.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const total = rows.rows.length > 0 ? parseInt(rows.rows[0].total_count, 10) : 0;
    const data  = rows.rows.map(({ total_count: _tc, ...rest }) => rest);

    res.json({
      success: true,
      data,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/import/validate?url=... ──────────────────────────────────────
// Pre-flight check: validate a URL before actually importing.
// Returns issues (errors + warnings) and the normalized URL.

export async function validateUrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const raw = req.query.url as string;
    if (!raw?.trim()) {
      throw new AppError("url query param is required", 400, "VALIDATION_ERROR");
    }
    const result = await validateImportUrl(raw.trim());
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── GET /api/import/health ────────────────────────────────────────────────
// Returns all active products that have data quality issues.

export async function healthCheck(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const reports = await auditProductHealth();
    res.json({
      success: true,
      data:    reports,
      summary: {
        total:    reports.length,
        errors:   reports.filter((r) => r.issues.some((i) => i.level === "error")).length,
        warnings: reports.filter((r) => r.issues.every((i) => i.level !== "error")).length,
      },
    });
  } catch (err) { next(err); }
}

// ── POST /api/import/catalog ──────────────────────────────────────────────
// Accepts a Sephora Turkey category/brand URL, scrapes all product links
// across pages, and enqueues (or runs inline) an import job for each one.

export async function startCatalogImport(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { url, max_pages = 10 } = req.body as { url: string; max_pages?: number };

    // Basic domain check via the existing validator
    const validation = await validateImportUrl(url, { allowCategory: true });
    if (!validation.valid) {
      const hardError = validation.issues.find((i) => i.level === "error");
      res.status(422).json({
        success: false,
        error:   hardError?.message ?? "URL validation failed",
        issues:  validation.issues,
      });
      return;
    }

    // Create a catalog_job record so the UI can poll progress
    const jobRes = await db.query<{ id: string }>(
      `INSERT INTO catalog_jobs (url, status, max_pages)
       VALUES ($1, 'processing', $2)
       RETURNING id`,
      [validation.normalized_url, max_pages]
    );
    const catalogJobId = jobRes.rows[0].id;

    // Scrape all product URLs (runs ~10-30s per page)
    let scraped;
    try {
      scraped = await scrapeSephoraCatalog(validation.normalized_url, {
        maxPages: max_pages,
        delayMs:  1200,
      });
    } catch (err: any) {
      await db.query(
        `UPDATE catalog_jobs SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, catalogJobId]
      );
      throw err;
    }

    const { product_urls, total_pages, scraped_pages } = scraped;

    // Enqueue / insert each product URL
    let queued = 0;
    let skipped = 0;
    const importIds: string[] = [];

    for (const productUrl of product_urls) {
      // Skip duplicates already in the DB
      const dup = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM import_urls WHERE url = $1",
        [productUrl]
      );
      if (dup.rows[0] && (dup.rows[0].status === "queued" || dup.rows[0].status === "processing" || dup.rows[0].status === "completed")) {
        skipped++;
        continue;
      }

      let importId: string;
      if (dup.rows[0]) {
        // Re-queue previously failed
        await db.query(
          `UPDATE import_urls SET status = 'queued', error_message = NULL, job_id = NULL WHERE id = $1`,
          [dup.rows[0].id]
        );
        importId = dup.rows[0].id;
      } else {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO import_urls (url, status) VALUES ($1, 'queued') RETURNING id`,
          [productUrl]
        );
        importId = ins.rows[0].id;
      }

      // Try to enqueue; if no Redis, we'll acknowledge but not run inline
      // (running 100+ products inline would time out the HTTP request)
      const jobId = await enqueueImport({ url: productUrl, importId });
      if (jobId) {
        await db.query("UPDATE import_urls SET job_id = $1 WHERE id = $2", [jobId, importId]);
      }

      importIds.push(importId);
      queued++;
    }

    // Mark catalog job done
    await db.query(
      `UPDATE catalog_jobs
       SET status = 'completed',
           product_count = $1,
           scraped_pages = $2,
           total_pages   = $3,
           completed_at  = NOW()
       WHERE id = $4`,
      [queued, scraped_pages, total_pages, catalogJobId]
    );

    res.status(202).json({
      success:       true,
      message:       `Catalog scraped — ${queued} products queued, ${skipped} skipped`,
      catalog_job_id: catalogJobId,
      queued,
      skipped,
      total_found:   product_urls.length,
      scraped_pages,
      total_pages,
      import_ids:    importIds,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/import/bulk ─────────────────────────────────────────────────
// Accept a list of up to 100 Sephora Turkey URLs, validate each one,
// then enqueue (or run inline) an import job for every valid URL.
// Invalid URLs are reported back but never block the rest.

export interface BulkUrlItem {
  url:        string;
  status:     "queued" | "skipped" | "invalid";
  import_id?: string;
  job_id?:    string;
  reason?:    string;  // validation error message or "duplicate"
}

export async function startBulkImport(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { urls } = req.body as { urls: string[] };

    const results: BulkUrlItem[] = [];

    for (const rawUrl of urls) {
      const trimmed = (rawUrl ?? "").trim();
      if (!trimmed) continue;

      // ── Validate ────────────────────────────────────────────────────────
      const validation = await validateImportUrl(trimmed);

      if (!validation.valid) {
        const hardError = validation.issues.find((i) => i.level === "error");
        results.push({
          url:    trimmed,
          status: "invalid",
          reason: hardError?.message ?? "Validation failed",
        });
        continue;
      }

      const cleanUrl = validation.normalized_url;

      // ── Duplicate check ─────────────────────────────────────────────────
      const existing = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM import_urls WHERE url = $1",
        [cleanUrl]
      );

      let importId: string;

      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.status === "processing" || row.status === "queued") {
          results.push({
            url:       cleanUrl,
            status:    "skipped",
            import_id: row.id,
            reason:    "Already in queue",
          });
          continue;
        }
        if (row.status === "completed" || row.status === "updated") {
          results.push({
            url:       cleanUrl,
            status:    "skipped",
            import_id: row.id,
            reason:    "Already imported",
          });
          continue;
        }
        // Previously failed — re-queue
        await db.query(
          `UPDATE import_urls SET status = 'queued', error_message = NULL, job_id = NULL WHERE id = $1`,
          [row.id]
        );
        importId = row.id;
      } else {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO import_urls (url, status) VALUES ($1, 'queued') RETURNING id`,
          [cleanUrl]
        );
        importId = ins.rows[0].id;
      }

      // ── Enqueue or background-run ────────────────────────────────────────
      const jobId = await enqueueImport({ url: cleanUrl, importId });
      if (jobId) {
        await db.query("UPDATE import_urls SET job_id = $1 WHERE id = $2", [jobId, importId]);
      } else {
        // No Redis — fire each import as a background task (non-blocking)
        const capturedUrl = cleanUrl;
        const capturedId  = importId;
        setImmediate(() => {
          importFromUrl(capturedUrl, capturedId).catch((err) => {
            console.error(`[bulk] background job failed for ${capturedId}:`, err?.message);
          });
        });
      }

      results.push({
        url:       cleanUrl,
        status:    "queued",
        import_id: importId,
        job_id:    jobId ?? undefined,
      });
    }

    const queued  = results.filter((r) => r.status === "queued").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const invalid = results.filter((r) => r.status === "invalid").length;

    res.status(202).json({
      success: true,
      message: `${queued} queued, ${skipped} skipped, ${invalid} invalid`,
      queued,
      skipped,
      invalid,
      results,
      import_ids: results
        .filter((r) => r.status === "queued" && r.import_id)
        .map((r) => r.import_id!),
    });
  } catch (err) {
    next(err);
  }
}
