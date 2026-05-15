import { Router } from "express";
import { param, body } from "express-validator";
import { validate } from "../middleware/validate.middleware";
import { requireAdmin } from "../middleware/auth.middleware";
import {
  getSettings,
  updateSetting,
  refreshExchangeRate,
  previewPrice,
  repriceAll,
} from "../controllers/settings.controller";

const router = Router();

// Allowlist of keys that may be updated via the API.
// Prevents arbitrary key injection into the settings table.
const ALLOWED_KEYS = [
  "exchange_rate_try_lyd",
  "shipping_cost_lyd",
  "free_shipping_threshold",
  "profit_margin_makeup",
  "profit_margin_skincare",
  "profit_margin_fragrance",
  "profit_margin_haircare",
  "profit_margin_default",
  "whatsapp_admin_number",
  "max_import_retries",
];

// GET  /api/settings  — admin only (contains business config)
router.get("/", requireAdmin, getSettings);

// POST /api/settings/refresh-rate
router.post("/refresh-rate", requireAdmin, refreshExchangeRate);

// POST /api/settings/preview-price
router.post(
  "/preview-price",
  requireAdmin,
  [body("try_price").isFloat({ min: 0.01 }).withMessage("try_price must be > 0")],
  validate,
  previewPrice
);

// POST /api/settings/reprice-all
router.post("/reprice-all", requireAdmin, repriceAll);

// PATCH /api/settings/:key
router.patch(
  "/:key",
  requireAdmin,
  [
    param("key")
      .notEmpty().withMessage("key is required")
      .isIn(ALLOWED_KEYS).withMessage(`key must be one of: ${ALLOWED_KEYS.join(", ")}`),
  ],
  validate,
  updateSetting
);

export default router;
