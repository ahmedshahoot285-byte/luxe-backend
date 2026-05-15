import { db } from "../db";
import { NotFoundError } from "../utils/errors";

// ── Types ──────────────────────────────────────────────────────────────────

export type OrderStatus =
  | "placed"
  | "pending"
  | "confirmed"
  | "purchased"
  | "shipped"
  | "delivered"
  | "cancelled";

export interface OrderItem {
  product_id:    string;
  product_name:  string;
  product_brand: string;
  variant_label?: string;
  unit_price_lyd: number;
  quantity:       number;
  line_total_lyd: number;
}

export interface Order {
  id:               string;
  order_number:     string;
  user_id?:         string;
  customer_name:    string;
  customer_phone:   string;
  customer_city:    string;
  customer_address: string;
  customer_notes?:  string;
  subtotal_lyd:     number;
  shipping_lyd:     number;
  total_lyd:        number;
  status:           OrderStatus;
  status_updated_at:string;
  whatsapp_sent:    boolean;
  whatsapp_sent_at?: string;
  admin_notes?:     string;
  cancelled_reason?: string;
  created_at:       string;
  updated_at:       string;
  items?:           OrderItem[];
}

export interface CreateOrderInput {
  customer_name:    string;
  customer_phone:   string;
  customer_city:    string;
  customer_address: string;
  customer_notes?:  string;
  customer_ip?:     string;
  fraud_score?:     number;
  fraud_flags?:     string[];
  items: {
    product_id?:   string;
    product_name:  string;
    product_brand?: string;
    variant_label?: string;
    unit_price_lyd: number;
    quantity:       number;
  }[];
}

export interface OrderFilters {
  status?: OrderStatus;
  search?: string;  // searches customer name, phone, order_number
  page?:   number;
  limit?:  number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const FREE_SHIPPING_THRESHOLD = 300;
export const SHIPPING_COST           = 25;

export function calcShipping(subtotal: number): number {
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
}

// ── Model ──────────────────────────────────────────────────────────────────

export const OrderModel = {

  async findAll(filters: OrderFilters = {}): Promise<{ orders: Order[]; total: number }> {
    const { page = 1, limit = 20, status, search } = filters;
    const offset = (page - 1) * limit;
    const conds: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (status) { conds.push(`o.status = $${p++}`); params.push(status); }
    if (search) {
      conds.push(`(o.order_number ILIKE $${p} OR o.customer_name ILIKE $${p} OR o.customer_phone ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM orders o ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const rows = await db.query<Order>(
      `SELECT o.*
       FROM orders o
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    return { orders: rows.rows, total };
  },

  async findById(id: string): Promise<Order> {
    const orderRes = await db.query<Order>(
      `SELECT * FROM orders WHERE id = $1`, [id]
    );
    if (!orderRes.rows[0]) throw new NotFoundError("Order");
    const order = orderRes.rows[0];

    const itemsRes = await db.query<OrderItem>(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at`, [id]
    );
    order.items = itemsRes.rows;
    return order;
  },

  async findByOrderNumber(orderNumber: string): Promise<Order> {
    const res = await db.query<Order>(
      `SELECT * FROM orders WHERE order_number = $1`, [orderNumber]
    );
    if (!res.rows[0]) throw new NotFoundError("Order");
    const order = res.rows[0];
    const itemsRes = await db.query<OrderItem>(
      `SELECT * FROM order_items WHERE order_id = $1`, [order.id]
    );
    order.items = itemsRes.rows;
    return order;
  },

  async create(input: CreateOrderInput): Promise<Order> {
    // Calculate totals
    const subtotal = input.items.reduce(
      (sum, item) => sum + item.unit_price_lyd * item.quantity, 0
    );
    const shipping = calcShipping(subtotal);

    return db.transaction(async (client) => {
      // Create order
      const orderRes = await client.query<Order>(
        `INSERT INTO orders (
           customer_name, customer_phone, customer_city,
           customer_address, customer_notes,
           subtotal_lyd, shipping_lyd, status,
           customer_ip, fraud_score, fraud_flags
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'placed',$8,$9,$10)
         RETURNING *`,
        [
          input.customer_name,
          input.customer_phone,
          input.customer_city,
          input.customer_address,
          input.customer_notes ?? null,
          subtotal,
          shipping,
          input.customer_ip    ?? null,
          input.fraud_score    ?? 0,
          JSON.stringify(input.fraud_flags ?? []),
        ]
      );
      const order = orderRes.rows[0];

      // Insert items
      for (const item of input.items) {
        await client.query(
          `INSERT INTO order_items (
             order_id, product_id, product_name, product_brand,
             variant_label, unit_price_lyd, quantity
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            order.id,
            item.product_id ?? null,
            item.product_name,
            item.product_brand ?? null,
            item.variant_label ?? null,
            item.unit_price_lyd,
            item.quantity,
          ]
        );
      }

      // Log
      await client.query(
        `INSERT INTO logs (type, level, message, metadata)
         VALUES ('order','info',$1,$2)`,
        [
          `New order ${order.order_number} from ${input.customer_name}`,
          JSON.stringify({ order_id: order.id, total: subtotal + shipping }),
        ]
      );

      return {
        ...order,
        items: input.items.map((item) => ({
          ...item,
          product_id:    item.product_id    ?? null,
          product_brand: item.product_brand ?? null,
          variant_label: item.variant_label ?? null,
          line_total_lyd: item.unit_price_lyd * item.quantity,
        })) as OrderItem[],
      };
    });
  },

  async updateStatus(
    id: string,
    status: OrderStatus,
    adminNotes?: string
  ): Promise<Order> {
    await this.findById(id); // 404 guard

    const res = await db.query<Order>(
      `UPDATE orders
       SET status = $1::order_status_enum,
           status_updated_at = NOW(),
           admin_notes = COALESCE($2, admin_notes),
           cancelled_reason = CASE WHEN $1 = 'cancelled' THEN $2 ELSE cancelled_reason END
       WHERE id = $3
       RETURNING *`,
      [status, adminNotes ?? null, id]
    );

    await db.query(
      `INSERT INTO logs (type, level, message, metadata)
       VALUES ('order','info',$1,$2)`,
      [
        `Order status updated to ${status}`,
        JSON.stringify({ order_id: id, status }),
      ]
    );

    return res.rows[0];
  },

  async markWhatsAppSent(id: string): Promise<void> {
    await db.query(
      `UPDATE orders SET whatsapp_sent = TRUE, whatsapp_sent_at = NOW() WHERE id = $1`,
      [id]
    );
  },
};
