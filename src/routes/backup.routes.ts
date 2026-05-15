import { Router } from "express";
import { param } from "express-validator";
import { validate }      from "../middleware/validate.middleware";
import { requireAdmin }  from "../middleware/auth.middleware";
import {
  listBackups,
  getBackup,
  triggerBackup,
  downloadBackup,
} from "../controllers/backup.controller";

const router = Router();

// All backup endpoints are admin-only
router.use(requireAdmin);

router.get("/",           listBackups);
router.post("/run",       triggerBackup);

router.get(
  "/:id",
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  getBackup
);

router.get(
  "/:id/download",
  [param("id").isUUID().withMessage("id must be a valid UUID")],
  validate,
  downloadBackup
);

export default router;
