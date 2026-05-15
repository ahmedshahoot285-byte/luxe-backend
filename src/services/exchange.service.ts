import { db } from "../db";

// ── Config ─────────────────────────────────────────────────────────────────
//
// Free API: open.er-api.com — no key required, updates every 24 h.
// Returns: { base_code: "TRY", rates: { LYD: 0.14, USD: 0.028, ... } }

const RATE_API = "https://open.er-api.com/v6/latest/TRY";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const SETTINGS_KEY = "exchange_rate_try_lyd";
const LAST_FETCH_KEY = "exchange_rate_last_fetched";

// ── Fetch live rate from API ───────────────────────────────────────────────

export async function fetchLiveRate(): Promise<{
  rate: number;
  source: "api" | "db_cache" | "fallback";
  fetched_at?: string;
}> {
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(RATE_API, {
      signal: controller.signal,
      headers: { "User-Agent": "LuxeApp/1.0" },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`API responded ${res.status}`);

    const json = (await res.json()) as {
      result: string;
      rates:  Record<string, number>;
    };

    if (json.result !== "success" || !json.rates.LYD) {
      throw new Error("LYD not in response");
    }

    const rate = Number(json.rates.LYD.toFixed(4));
    const now  = new Date().toISOString();

    // Persist to DB so admin can see what rate is active
    await db.query(
      `INSERT INTO settings (key, value, description)
       VALUES ($1, $2::text::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [SETTINGS_KEY, String(rate), "TRY → LYD conversion rate (auto-updated)"]
    );
    await db.query(
      `INSERT INTO settings (key, value, description)
       VALUES ($1, $2::text::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [LAST_FETCH_KEY, JSON.stringify(now), "Timestamp of last live exchange-rate fetch"]
    );

    console.log(`✓ Exchange rate updated: 1 TRY = ${rate} LYD`);
    return { rate, source: "api", fetched_at: now };

  } catch (err: any) {
    console.warn("⚠  Exchange rate fetch failed:", err.message);

    // Fall back to whatever's in the DB
    try {
      const row = await db.query<{ value: string }>(
        "SELECT value FROM settings WHERE key = $1", [SETTINGS_KEY]
      );
      if (row.rows[0]) {
        return { rate: parseFloat(row.rows[0].value), source: "db_cache" };
      }
    } catch {}

    return { rate: 0.15, source: "fallback" };
  }
}

// ── Auto-refresh if cache is stale ────────────────────────────────────────
//
// Call this at server startup. If the cached rate is older than TTL
// (or missing), kick off a background refresh so first request is
// always served quickly.

export async function warmExchangeRate(): Promise<void> {
  try {
    const lastRes = await db.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1", [LAST_FETCH_KEY]
    );

    if (lastRes.rows[0]) {
      const lastFetch = new Date(JSON.parse(lastRes.rows[0].value)).getTime();
      if (Date.now() - lastFetch < CACHE_TTL_MS) {
        console.log("✓ Exchange rate cache is fresh");
        return;
      }
    }

    // Cache is stale or missing — refresh in background (don't await)
    fetchLiveRate().catch(() => {});
  } catch {
    fetchLiveRate().catch(() => {});
  }
}
