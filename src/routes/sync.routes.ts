import { Router } from "express";
import { param } from "express-validator";
import { validate } from "../middleware/validate.middleware";
import { requireAdmin } from "../middleware/auth.middleware";
import {
  triggerSync,
  cancelSyncJob,
  syncOneProduct,
  getSyncStatus,
  getSyncJob,
} from "../controllers/sync.controller";

const router = Router();

// All sync routes are admin-only
router.get("/status", requireAdmin, getSyncStatus);
router.post("/run",   requireAdmin, triggerSync);

router.post(
  "/cancel/:id",
  requireAdmin,
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  cancelSyncJob
);

router.post(
  "/product/:id",
  requireAdmin,
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  syncOneProduct
);

router.get(
  "/:id",
  requireAdmin,
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  getSyncJob
);

export default router;
