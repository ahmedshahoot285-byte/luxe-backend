import { Router } from "express";
import { body, param, query } from "express-validator";
import { validate } from "../middleware/validate.middleware";
import { requireAdmin } from "../middleware/auth.middleware";
import { extractIp } from "../middleware/ip.middleware";
import {
  createOrder, getOrders, getOrderById,
  trackOrder,  updateOrderStatus,
} from "../controllers/orders.controller";

const router = Router();

const ORDER_STATUSES = [
  "placed", "pending", "confirmed",
  "purchased", "shipped", "delivered", "cancelled",
];

// ── Validation rules ──────────────────────────────────────────────────────

const createRules = [
  body("customer_name").trim().notEmpty().withMessage("customer_name is required"),
  body("customer_phone").trim().notEmpty().withMessage("customer_phone is required"),
  body("customer_city").trim().notEmpty().withMessage("customer_city is required"),
  body("customer_address").trim().notEmpty().withMessage("customer_address is required"),
  body("items").isArray({ min: 1 }).withMessage("items must be a non-empty array"),
  body("items.*.product_name").notEmpty().withMessage("Each item needs a product_name"),
  body("items.*.unit_price_lyd").isFloat({ min: 0 }).withMessage("Each item needs a valid price"),
  body("items.*.quantity").isInt({ min: 1 }).withMessage("Each item needs quantity >= 1"),
];

const statusRules = [
  param("id").isUUID(),
  body("status")
    .notEmpty().withMessage("status is required")
    .isIn(ORDER_STATUSES).withMessage(`status must be one of: ${ORDER_STATUSES.join(", ")}`),
];

// ── Public routes ─────────────────────────────────────────────────────────

router.post("/",        extractIp,     createRules,   validate, createOrder);
router.get( "/track/:orderNumber",                              trackOrder);

// ── Admin routes (require authentication) ────────────────────────────────

router.get(
  "/",
  requireAdmin,
  [query("page").optional().isInt({ min: 1 })],
  validate,
  getOrders
);

router.get(
  "/:id",
  requireAdmin,
  [param("id").isUUID()],
  validate,
  getOrderById
);

router.patch(
  "/:id/status",
  requireAdmin,
  statusRules,
  validate,
  updateOrderStatus
);

export default router;
