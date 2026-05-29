import { Request, Response, NextFunction } from "express";
import { ProductModel, ProductFilters } from "../models/product.model";
import { db } from "../db";

// Helper: safely extract a single string from req.query
function qs(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

// GET /api/products
export async function getAllProducts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Resolve category: accept either ?category_id=<uuid> or ?category=<slug>
    let category_id = qs(req, "category_id");
    const categorySlug = qs(req, "category");
    if (!category_id && categorySlug) {
      const catRow = await db.query<{ id: string }>(
        "SELECT id FROM categories WHERE slug = $1 AND is_active = TRUE LIMIT 1",
        [categorySlug]
      );
      category_id = catRow.rows[0]?.id;
    }

    const filters: ProductFilters = {
      page:         qs(req, "page")         ? Number(qs(req, "page"))        : 1,
      limit:        qs(req, "limit")        ? Number(qs(req, "limit"))       : 20,
      sort:         (qs(req, "sort") as ProductFilters["sort"]) ?? "newest",
      search:       qs(req, "search"),
      category_id,
      brand_id:     qs(req, "brand_id"),
      stock_status: (qs(req, "stock_status") as ProductFilters["stock_status"]),
      is_featured:  qs(req, "featured") === "true" ? true : undefined,
      min_price:    qs(req, "min_price")    ? Number(qs(req, "min_price"))   : undefined,
      max_price:    qs(req, "max_price")    ? Number(qs(req, "max_price"))   : undefined,
      // "all" → undefined (no filter, admin view)
      // "false" → false (inactive only)
      // anything else / omitted → true (active only, storefront default)
      is_active:    qs(req, "is_active") === "all"
        ? undefined
        : qs(req, "is_active") !== "false",
    };

    const { products, total } = await ProductModel.findAll(filters);
    const page  = filters.page  ?? 1;
    const limit = filters.limit ?? 20;

    // Public listing: browsers and CDNs may serve from cache for up to 2 min,
    // continuing to serve stale content for 5 min while revalidating.
    res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");

    res.json({
      success: true,
      data: products,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/products/:id
export async function getProductById(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const product = await ProductModel.findById(req.params.id);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}

// GET /api/products/slug/:slug
export async function getProductBySlug(
  req: Request<{ slug: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const product = await ProductModel.findBySlug(req.params.slug);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}

// POST /api/products
export async function createProduct(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = { ...req.body };

    // If brand_name is provided instead of brand_id, resolve / create the brand
    if (body.brand_name && !body.brand_id) {
      const slug = body.brand_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const brandRes = await db.query<{ id: string }>(
        `INSERT INTO brands (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [body.brand_name.trim(), slug]
      );
      body.brand_id = brandRes.rows[0]?.id ?? null;
    }
    delete body.brand_name;

    const product = await ProductModel.create(body);
    res.status(201).json({
      success: true,
      message: "Product created",
      data: product,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/products/:id
export async function updateProduct(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const product = await ProductModel.update(req.params.id, req.body);
    res.json({
      success: true,
      message: "Product updated",
      data: product,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/products/:id
export async function deleteProduct(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await ProductModel.delete(req.params.id);
    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    next(err);
  }
}
