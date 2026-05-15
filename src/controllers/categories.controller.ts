import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { cache, TTL } from "../utils/cache";

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  product_count: string;
}

// GET /api/categories
export async function getCategories(
  _req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const CACHE_KEY = "categories:list";
    const cached = cache.get<CategoryRow[]>(CACHE_KEY);
    if (cached) {
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
      res.json({ success: true, data: cached });
      return;
    }

    const result = await db.query<CategoryRow>(
      `SELECT
         c.id,
         c.name,
         c.slug,
         COUNT(p.id) FILTER (WHERE p.is_active = TRUE) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       WHERE c.is_active = TRUE
       GROUP BY c.id, c.name, c.slug, c.sort_order
       ORDER BY c.sort_order ASC, c.name ASC`
    );

    const categories = result.rows.map((r) => ({
      ...r,
      product_count: parseInt(r.product_count, 10),
    }));

    cache.set(CACHE_KEY, categories, TTL.BRANDS); // reuse 30-min TTL
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json({ success: true, data: categories });
  } catch (err) {
    next(err);
  }
}
