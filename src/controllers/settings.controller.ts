import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { fetchLiveRate } from "../services/exchange.service";
import { getPricingConfig, calculateLydPrice, detectCategory, invalidatePricingCache } from "../services/pricing.service";
import { AppError } from "../utils/errors";

// ── GET /api/settings ─────────────────────────────────────────────────────

export async function getSettings(
  _req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const rows = await db.query<{ key: string; value: string; description: string; updated_at: string }>(
      "SELECT key, value, description, updated_at FROM settings ORDER BY key"
    );
    const map: Record<string, { value: unknown; description: string; updated_at: string }> = {};
    for (const row of rows.rows) {
      try { map[row.key] = { value: JSON.parse(row.value), description: row.description, updated_at: row.updated_at }; }
      catch { map[row.key] = { value: row.value, description: row.description, updated_at: row.updated_at }; }
    }
    res.json({ success: true, data: map });
  } catch (err) { next(err); }
}

// ── PATCH /api/settings/:key ──────────────────────────────────────────────

export async function updateSetting(
  req: Request<{ key: string }>, res: Response, next: NextFunction
): Promise<void> {
  try {
    const { key } = req.params;
    const { value, description } = req.body as { value: unknown; description?: string };

    if (value === undefined) {
      throw new AppError("value is required", 400, "VALIDATION_ERROR");
    }

    const jsonValue = JSON.stringify(value);

    const result = await db.query<{ key: string; value: string; updated_at: string }>(
      `INSERT INTO settings (key, value, description)
       VALUES ($1, $2::text::jsonb, COALESCE($3, ''))
       ON CONFLICT (key) DO UPDATE
         SET value       = EXCLUDED.value,
             description = COALESCE(EXCLUDED.description, settings.description),
             updated_at  = NOW()
       RETURNING key, value, updated_at`,
      [key, jsonValue, description ?? null]
    );

    // Bust pricing cache so the next import/sync picks up the new values
    invalidatePricingCache();

    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
}

// ── POST /api/settings/refresh-rate ──────────────────────────────────────

export async function refreshExchangeRate(
  _req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const result = await fetchLiveRate();
    // New exchange rate → pricing config is stale
    invalidatePricingCache();
    res.json({
      success: true,
      message: `Rate refreshed: 1 TRY = ${result.rate} LYD`,
      data: result,
    });
  } catch (err) { next(err); }
}

// ── POST /api/settings/preview-price ─────────────────────────────────────
// Body: { try_price: number, category?: string }

export async function previewPrice(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const try_price = Number(req.body.try_price);
    if (!try_price || try_price <= 0) {
      throw new AppError("try_price must be a positive number", 400, "VALIDATION_ERROR");
    }

    type Cat = "makeup" | "skincare" | "fragrance" | "haircare" | "default";
    const category = (req.body.category as Cat) ?? "default";
    const config   = await getPricingConfig(category);

    const base        = try_price * config.exchange_rate_try_lyd;
    const with_ship   = base + config.shipping_cost_lyd;
    const with_margin = with_ship * (1 + config.profit_margin);
    const final       = Math.ceil(with_margin / 5) * 5;

    res.json({
      success: true,
      data: {
        try_price,
        category,
        exchange_rate:   config.exchange_rate_try_lyd,
        shipping_cost:   config.shipping_cost_lyd,
        profit_margin:   config.profit_margin,
        base_lyd:        Number(base.toFixed(2)),
        with_shipping:   Number(with_ship.toFixed(2)),
        with_margin:     Number(with_margin.toFixed(2)),
        final_price_lyd: final,
      },
    });
  } catch (err) { next(err); }
}

// ── POST /api/settings/reprice-all ───────────────────────────────────────
// Recalculates price_lyd for every product that has a scraped TRY price
// stored in import_urls.scraped_data.

export async function repriceAll(
  _req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    // Fetch all products that have scraped TRY price data
    const rows = await db.query<{
      product_id:   string;
      name:         string;
      description:  string | null;
      price_try:    number;
    }>(
      `SELECT DISTINCT ON (iu.product_id)
         iu.product_id,
         p.name,
         p.description,
         (iu.scraped_data->>'price_try')::numeric AS price_try
       FROM import_urls iu
       JOIN products p ON p.id = iu.product_id
       WHERE iu.scraped_data IS NOT NULL
         AND (iu.scraped_data->>'price_try')::numeric > 0
         AND iu.status IN ('completed', 'updated')
       ORDER BY iu.product_id, iu.completed_at DESC NULLS LAST`
    );

    if (rows.rows.length === 0) {
      res.json({ success: true, message: "No products with TRY price data found", updated: 0 });
      return;
    }

    let updated = 0;
    const errors: string[] = [];

    for (const row of rows.rows) {
      try {
        const category = detectCategory(row.name, row.description ?? "");
        const config   = await getPricingConfig(category);
        const newPrice = calculateLydPrice(Number(row.price_try), config);

        await db.query(
          `UPDATE products
           SET price_lyd = $1, last_synced_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [newPrice, row.product_id]
        );
        updated++;
      } catch (e: any) {
        errors.push(`${row.name}: ${e.message}`);
      }
    }

    // Log the reprice
    await db.query(
      `INSERT INTO logs (type, level, message, metadata)
       VALUES ('pricing', 'info', $1, $2)`,
      [
        `Bulk reprice: ${updated} products updated`,
        JSON.stringify({ updated, errors: errors.length }),
      ]
    ).catch(() => {});

    // Products were updated in bulk — bust product list cache
    const { cache } = await import("../utils/cache");
    cache.invalidatePrefix("products:list:");

    res.json({
      success: true,
      message: `Repriced ${updated} of ${rows.rows.length} products`,
      data: { total: rows.rows.length, updated, errors },
    });
  } catch (err) { next(err); }
}
