import { Router } from "express";
import { body, param, query } from "express-validator";
import { validate } from "../middleware/validate.middleware";
import { requireAdmin } from "../middleware/auth.middleware";
import {
  startImport,
  getImportStatus,
  listImports,
  validateUrl,
  healthCheck,
  startCatalogImport,
  startBulkImport,
} from "../controllers/import.controller";

const router = Router();

// POST /api/import          → submit a Sephora URL for import (admin)
router.post(
  "/",
  requireAdmin,
  [
    body("url")
      .trim()
      .notEmpty().withMessage("url is required")
      .isURL({ require_protocol: true }).withMessage("url must be a valid URL"),
  ],
  validate,
  startImport
);

// POST /api/import/catalog  → bulk-import all products from a category/brand page (admin)
router.post(
  "/catalog",
  requireAdmin,
  [
    body("url")
      .trim()
      .notEmpty().withMessage("url is required")
      .isURL({ require_protocol: true }).withMessage("url must be a valid URL"),
    body("max_pages")
      .optional()
      .isInt({ min: 1, max: 50 }).withMessage("max_pages must be between 1 and 50"),
  ],
  validate,
  startCatalogImport
);

// POST /api/import/bulk     → import a list of product URLs at once (admin)
router.post(
  "/bulk",
  requireAdmin,
  [
    body("urls")
      .isArray({ min: 1, max: 100 }).withMessage("urls must be an array of 1–100 items"),
    body("urls.*")
      .trim()
      .isURL({ require_protocol: true }).withMessage("each url must be valid"),
  ],
  validate,
  startBulkImport
);

// GET  /api/import          → list all import jobs (admin)
router.get(
  "/",
  requireAdmin,
  [
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("status").optional().isIn([
      "queued", "processing", "completed", "updated", "failed", "skipped",
    ]),
  ],
  validate,
  listImports
);

// GET  /api/import/validate  → pre-flight URL check — admin only (must be before /:id)
router.get(
  "/validate",
  requireAdmin,
  [query("url").notEmpty().withMessage("url is required")],
  validate,
  validateUrl
);

// GET  /api/import/health    → product health audit — admin only (must be before /:id)
router.get("/health", requireAdmin, healthCheck);

// GET  /api/import/:id       → poll a single job status
router.get(
  "/:id",
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  getImportStatus
);

export default router;
