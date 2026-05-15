/**
 * fraud.service.ts
 *
 * Anti-fraud checks for COD orders.
 *
 * Hard blocks  (throw 429):
 *   • Invalid Libyan phone number
 *   • Same phone placed ≥ 3 non-cancelled orders in the last 24 hours
 *   • Same IP placed ≥ 5 orders in the last 1 hour
 *
 * Soft flags (order allowed, admin sees warning badges):
 *   • Phone has ≥ 2 currently active orders (placed/confirmed/purchased/shipped)
 *   • Same phone ordered the same product within the last 24 hours
 */

import { db } from "../db";
import { AppError } from "../utils/errors";

// ── Phone normalisation & validation ──────────────────────────────────────

/**
 * Strip formatting characters and normalise to a canonical form:
 *   - Local:         09XXXXXXXX      (10 digits)
 *   - International: 2189XXXXXXXX   (12 digits, no leading +)
 *
 * Returns the normalised phone string, or throws ValidationError.
 */
export function normalisePhone(raw: string): string {
  // Remove spaces, dashes, dots, parentheses
  let phone = raw.replace(/[\s\-().]/g, "");

  // Strip leading +
  if (phone.startsWith("+")) phone = phone.slice(1);

  // Strip leading 00
  if (phone.startsWith("00")) phone = phone.slice(2);

  // Normalise 218 prefix variants
  // 218 9XXXXXXXX → 2189XXXXXXXX (already fine)
  // 09XXXXXXXX → keep as-is

  const localRe  = /^09\d{8}$/;        // 09-XXXX-XXXX
  const intlRe   = /^2189\d{8}$/;      // 218-9X-XXXX-XXXX

  if (localRe.test(phone) || intlRe.test(phone)) return phone;

  throw new AppError(
    "Invalid phone number. Please enter a valid Libyan mobile number (e.g. 0912345678).",
    400,
    "INVALID_PHONE"
  );
}

// ── Fraud check result ────────────────────────────────────────────────────

export interface FraudResult {
  score: number;           // 0–100; ≥60 was blocked (so won't reach here)
  flags: string[];         // human-readable warning tags
}

// ── Main fraud check ──────────────────────────────────────────────────────

const PHONE_24H_LIMIT  = 3;   // max non-cancelled orders from same phone per 24h
const IP_1H_LIMIT      = 5;   // max orders from same IP per hour
const ACTIVE_LIMIT     = 2;   // max simultaneously active orders per phone

export async function checkFraud(
  phone: string,
  ip: string | undefined,
  productIds: string[]
): Promise<FraudResult> {
  const flags: string[] = [];
  let   score           = 0;

  // ── 1. Phone rate limit (24h) ─────────────────────────────────────────
  const phoneCountRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM orders
     WHERE customer_phone = $1
       AND status <> 'cancelled'
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [phone]
  );
  const phoneCount = parseInt(phoneCountRes.rows[0].cnt, 10);

  if (phoneCount >= PHONE_24H_LIMIT) {
    throw new AppError(
      `Too many orders from this phone number. Please wait before placing another order, or contact us via WhatsApp.`,
      429,
      "RATE_LIMIT_PHONE"
    );
  }

  // ── 2. IP rate limit (1h) ─────────────────────────────────────────────
  if (ip) {
    const ipCountRes = await db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM orders
       WHERE customer_ip = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [ip]
    );
    const ipCount = parseInt(ipCountRes.rows[0].cnt, 10);

    if (ipCount >= IP_1H_LIMIT) {
      throw new AppError(
        "Too many orders placed from this device. Please try again later.",
        429,
        "RATE_LIMIT_IP"
      );
    }

    if (ipCount >= 2) {
      flags.push("multiple_orders_same_ip");
      score += 15;
    }
  }

  // ── 3. Active orders for this phone ──────────────────────────────────
  const activeCountRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM orders
     WHERE customer_phone = $1
       AND status IN ('placed','pending','confirmed','purchased','shipped')`,
    [phone]
  );
  const activeCount = parseInt(activeCountRes.rows[0].cnt, 10);

  if (activeCount >= ACTIVE_LIMIT) {
    flags.push("high_active_orders");
    score += 25;
  }

  // ── 4. Duplicate product order in 24h ────────────────────────────────
  if (productIds.length > 0) {
    const dupRes = await db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.customer_phone = $1
         AND oi.product_id = ANY($2::uuid[])
         AND o.created_at > NOW() - INTERVAL '24 hours'
         AND o.status <> 'cancelled'`,
      [phone, productIds]
    );
    const dupCount = parseInt(dupRes.rows[0].cnt, 10);
    if (dupCount > 0) {
      flags.push("duplicate_product_24h");
      score += 20;
    }
  }

  return { score, flags };
}
