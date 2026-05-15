import { Router } from "express";
import { body, param, query } from "express-validator";
import { validate } from "../middleware/validate.middleware";
import { requireAdmin } from "../middleware/auth.middleware";
import {
  getAllProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/products.controller";

const router = Router();

// ── Validation chains ──────────────────────────────────────────────────────

const createRules = [
  body("name")
    .trim()
    .notEmpty().withMessage("name is required")
    .isLength({ max: 255 }).withMessage("name must be under 255 characters"),

  body("price_lyd")
    .notEmpty().withMessage("price_lyd is required")
    .isFloat({ min: 0 }).withMessage("price_lyd must be a positive number"),

  body("original_url")
    .optional()
    .isURL().withMessage("original_url must be a valid URL"),

  body("stock_status")
    .optional()
    .isIn(["in_stock", "low_stock", "out_of_stock"])
    .withMessage("stock_status must be in_stock | low_stock | out_of_stock"),

  body("stock_qty")
    .optional()
    .isInt({ min: 0 }).withMessage("stock_qty must be a non-negative integer"),

  body("images")
    .optional()
    .isArray().withMessage("images must be an array"),

  body("images.*.url")
    .isURL().withMessage("each image must have a valid url"),

  body("variants")
    .optional()
    .isArray().withMessage("variants must be an array"),

  body("variants.*.label")
    .notEmpty().withMessage("each variant must have a label"),

  body("variants.*.price_lyd")
    .isFloat({ min: 0 }).withMessage("each variant must have a valid price_lyd"),
];

const updateRules = [
  param("id").isUUID().withMessage("id must be a valid UUID"),

  body("name")
    .optional()
    .trim()
    .notEmpty().withMessage("name cannot be empty")
    .isLength({ max: 255 }),

  body("price_lyd")
    .optional()
    .isFloat({ min: 0 }).withMessage("price_lyd must be a positive number"),

  body("original_url")
    .optional()
    .isURL().withMessage("original_url must be a valid URL"),

  body("stock_status")
    .optional()
    .isIn(["in_stock", "low_stock", "out_of_stock"]),

  body("stock_qty")
    .optional()
    .isInt({ min: 0 }),

  body("images")
    .optional()
    .isArray(),

  body("variants")
    .optional()
    .isArray(),
];

const idRule = [
  param("id").isUUID().withMessage("id must be a valid UUID"),
];

const listRules = [
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("sort").optional().isIn(["newest", "price_asc", "price_desc", "name_asc"]),
  query("min_price").optional().isFloat({ min: 0 }),
  query("max_price").optional().isFloat({ min: 0 }),
];

// ── Routes ─────────────────────────────────────────────────────────────────

// GET  /api/products               → list with filters + pagination
// GET  /api/products/slug/:slug    → by slug (must be before /:id)
// GET  /api/products/:id           → by UUID
// POST /api/products               → create
// PATCH /api/products/:id          → partial update
// DELETE /api/products/:id         → delete

// Public (storefront)
router.get(  "/",           listRules,   validate, getAllProducts);
router.get(  "/slug/:slug",              getProductBySlug);
router.get(  "/:id",        idRule,      validate, getProductById);

// Admin-only (write operations)
router.post( "/",           requireAdmin, createRules, validate, createProduct);
router.patch("/:id",        requireAdmin, updateRules, validate, updateProduct);
router.delete("/:id",       requireAdmin, idRule,      validate, deleteProduct);

export default router;
