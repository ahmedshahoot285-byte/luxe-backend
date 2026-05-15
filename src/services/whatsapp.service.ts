import { db } from "../db";
import { Order } from "../models/order.model";

// ── Admin number (env fallback, overridden from settings DB) ──────────────

const ENV_NUMBER = process.env.WHATSAPP_ADMIN_NUMBER ?? "218910000000";

export async function getAdminNumber(): Promise<string> {
  try {
    const res = await db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'whatsapp_admin_number' LIMIT 1`
    );
    if (res.rows[0]) {
      // value is stored as a JSON string, e.g. '"218912345678"'
      const raw = res.rows[0].value;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string" && /^\d{10,15}$/.test(parsed.replace(/\D/g, ""))) {
        return parsed.replace(/\D/g, "");
      }
    }
  } catch { /* fall through */ }
  return ENV_NUMBER;
}

// ── Formatting helpers ────────────────────────────────────────────────────

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  // Libya is UTC+2
  const libyan = new Date(d.getTime() + 2 * 60 * 60 * 1000);
  const day   = String(libyan.getUTCDate()).padStart(2, "0");
  const month = libyan.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const year  = libyan.getUTCFullYear();
  const hh    = String(libyan.getUTCHours()).padStart(2, "0");
  const mm    = String(libyan.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}  ·  ${hh}:${mm}`;
}

function lyd(n: number | string): string {
  return `${Number(n).toFixed(0)} LYD`;
}

const SEP = "━━━━━━━━━━━━━━━━━━━━";

// ── Admin notification ────────────────────────────────────────────────────
// Sent to the admin's WhatsApp whenever a new order is placed.

export function buildAdminOrderMessage(order: Order): string {
  const items  = order.items ?? [];
  const count  = items.reduce((s, i) => s + i.quantity, 0);

  const itemLines = items.map((item) => {
    const variant = item.variant_label ? `  _(${item.variant_label})_` : "";
    const qty     = item.quantity;
    const unit    = Number(item.unit_price_lyd);
    const line    = Number(item.line_total_lyd ?? unit * qty);
    return (
      `• *${item.product_name}*${variant}\n` +
      `  ${qty} × ${lyd(unit)} = *${lyd(line)}*`
    );
  }).join("\n\n");

  const subtotal = Number(order.subtotal_lyd);
  const shipping = Number(order.shipping_lyd);
  const total    = Number(order.total_lyd ?? subtotal + shipping);
  const shippingLine = shipping === 0 ? "مجاني 🎁" : lyd(shipping);
  const date     = order.created_at ? formatDate(order.created_at) : "";

  const parts = [
    "🛒 *طلب جديد — LUXE*",
    SEP,
    "",
    `📋 *${order.order_number}*`,
    ...(date ? [`📅 ${date}`] : []),
    "",
    SEP,
    "👤 *معلومات العميل*",
    "",
    `*الاسم:*  ${order.customer_name}`,
    `*الهاتف:*  ${order.customer_phone}`,
    `*المدينة:*  ${order.customer_city}`,
    `*العنوان:*  ${order.customer_address}`,
    ...(order.customer_notes ? [`*ملاحظات:*  ${order.customer_notes}`] : []),
    "",
    SEP,
    `🛍️ *المنتجات (${count} ${count === 1 ? "قطعة" : "قطع"})*`,
    "",
    itemLines,
    "",
    SEP,
    "💰 *ملخص الطلب*",
    "",
    `المجموع الجزئي:  ${lyd(subtotal)}`,
    `الشحن:  ${shippingLine}`,
    "──────────────────",
    `*إجمالي الدفع:  ${lyd(total)}*`,
    "",
    "💵 _الدفع عند الاستلام (COD)_",
  ];

  return parts.join("\n");
}

export async function buildAdminOrderUrl(order: Order): Promise<string> {
  const number  = await getAdminNumber();
  const message = buildAdminOrderMessage(order);
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

// ── Customer follow-up link ───────────────────────────────────────────────
// Lets the customer open WhatsApp to ask about an existing order.

export async function buildCustomerFollowUpUrl(
  order: Order
): Promise<string> {
  const number = await getAdminNumber();
  const message = [
    "مرحباً 👋",
    "",
    `أودّ الاستفسار عن طلبي 📦`,
    "",
    `*رقم الطلب:* ${order.order_number}`,
    `*الاسم:* ${order.customer_name}`,
    `*الإجمالي:* ${lyd(order.total_lyd)}`,
  ].join("\n");

  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
