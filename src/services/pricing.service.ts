import { db } from "../db";
import { cache, TTL } from "../utils/cache";

export interface PricingConfig {
  exchange_rate_try_lyd: number;   // e.g. 0.15
  shipping_cost_lyd: number;       // flat per-item shipping
  profit_margin: number;           // e.g. 0.35 = 35%
}

type Category = "makeup" | "skincare" | "fragrance" | "haircare" | "default";

const FALLBACK: PricingConfig = {
  exchange_rate_try_lyd: 0.15,
  shipping_cost_lyd: 25,
  profit_margin: 0.35,
};

// ── Load all relevant settings in ONE query, cache the map ────────────────

async function loadSettingsMap(): Promise<Record<string, number>> {
  const CACHE_KEY = "settings:pricing_map";
  const cached = cache.get<Record<string, number>>(CACHE_KEY);
  if (cached) return cached;

  try {
    const result = await db.query<{ key: string; value: string }>(
      `SELECT key, value FROM settings
       WHERE key IN (
         'exchange_rate_try_lyd', 'shipping_cost_lyd',
         'profit_margin_makeup', 'profit_margin_skincare',
         'profit_margin_fragrance', 'profit_margin_haircare',
         'profit_margin_default'
       )`
    );
    const map: Record<string, number> = {};
    for (const row of result.rows) {
      const n = parseFloat(row.value);
      if (!isNaN(n)) map[row.key] = n;
    }
    cache.set(CACHE_KEY, map, TTL.SETTINGS);
    return map;
  } catch {
    return {};
  }
}

export async function getPricingConfig(category: Category = "default"): Promise<PricingConfig> {
  const cacheKey = `pricing:config:${category}`;
  const cached = cache.get<PricingConfig>(cacheKey);
  if (cached) return cached;

  const map = await loadSettingsMap();

  const config: PricingConfig = {
    exchange_rate_try_lyd: map["exchange_rate_try_lyd"]        ?? FALLBACK.exchange_rate_try_lyd,
    shipping_cost_lyd:     map["shipping_cost_lyd"]            ?? FALLBACK.shipping_cost_lyd,
    profit_margin:         map[`profit_margin_${category}`]    ?? map["profit_margin_default"] ?? FALLBACK.profit_margin,
  };

  cache.set(cacheKey, config, TTL.SETTINGS);
  return config;
}

/** Call after any settings update to ensure fresh pricing on next request */
export function invalidatePricingCache(): void {
  cache.invalidatePrefix("pricing:");
  cache.del("settings:pricing_map");
}

// ── Core formula ──────────────────────────────────────────────────────────
//
//   Final Price (LYD) = (TRY_price × exchange_rate + shipping) × (1 + margin)
//
// Rounded up to nearest 5 LYD for clean pricing.

export function calculateLydPrice(try_price: number, config: PricingConfig): number {
  if (try_price <= 0) return 0;

  const base       = try_price * config.exchange_rate_try_lyd;
  const withShip   = base + config.shipping_cost_lyd;
  const withProfit = withShip * (1 + config.profit_margin);

  // Round up to nearest 5
  return Math.ceil(withProfit / 5) * 5;
}

export function detectCategory(name: string, description: string): Category {
  const haystack = `${name} ${description}`.toLowerCase();

  if (/perfume|fragrance|edp|edt|eau de|parfum|cologne/.test(haystack)) return "fragrance";
  if (/foundation|mascara|lipstick|eyeshadow|blush|concealer|makeup|contour/.test(haystack)) return "makeup";
  if (/moisturi|serum|cleanser|toner|sunscreen|spf|retinol|hyaluronic|skincare/.test(haystack)) return "skincare";
  if (/shampoo|conditioner|hair mask|hair oil|scalp/.test(haystack)) return "haircare";

  return "default";
}
