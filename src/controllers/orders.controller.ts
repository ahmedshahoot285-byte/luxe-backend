import { Request, Response, NextFunction } from "express";
import { OrderModel, OrderStatus } from "../models/order.model";
import { buildAdminOrderUrl } from "../services/whatsapp.service";
import { normalisePhone, checkFraud } from "../services/fraud.service";
import { AppError } from "../utils/errors";

function qs(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

// ── POST /api/orders ─────────────────────────────────────────────────────
export async function createOrder(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const body = req.body as {
      customer_name:    string;
      customer_phone:   string;
      customer_city:    string;
      customer_address: string;
      customer_notes?:  string;
      items: { product_id?: string; product_name: string; product_brand?: string; variant_label?: string; unit_price_lyd: number; quantity: number }[];
    };

    // 1. Normalise & validate phone (throws 400 on invalid format)
    const phone = normalisePhone(body.customer_phone);

    // 2. Fraud checks (throws 429 on hard block, returns flags for soft flags)
    const productIds = body.items
      .map((i) => i.product_id)
      .filter((id): id is string => !!id);

    const { score, flags } = await checkFraud(phone, req.clientIp, productIds);

    // 3. Create order with normalised phone + fraud metadata
    const order = await OrderModel.create({
      ...body,
      customer_phone: phone,
      customer_ip:    req.clientIp,
      fraud_score:    score,
      fraud_flags:    flags,
    });

    // 4. Build WhatsApp URL — returned so frontend can open it
    const whatsappUrl = await buildAdminOrderUrl(order);
    await OrderModel.markWhatsAppSent(order.id);

    res.status(201).json({
      success:      true,
      message:      "Order placed successfully",
      data:         order,
      whatsapp_url: whatsappUrl,
      ...(flags.length > 0 && { fraud_flags: flags }),
    });
  } catch (err) { next(err); }
}

// ── GET /api/orders ──────────────────────────────────────────────────────
export async function getOrders(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const page  = Number(qs(req, "page")  ?? 1);
    const limit = Number(qs(req, "limit") ?? 20);
    const { orders, total } = await OrderModel.findAll({
      status: qs(req, "status") as OrderStatus | undefined,
      search: qs(req, "search"),
      page, limit,
    });

    res.json({
      success: true,
      data: orders,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
}

// ── GET /api/orders/:id ──────────────────────────────────────────────────
export async function getOrderById(
  req: Request<{ id: string }>, res: Response, next: NextFunction
): Promise<void> {
  try {
    const order = await OrderModel.findById(req.params.id);
    res.json({ success: true, data: order });
  } catch (err) { next(err); }
}

// ── GET /api/orders/track/:orderNumber ───────────────────────────────────
export async function trackOrder(
  req: Request<{ orderNumber: string }>, res: Response, next: NextFunction
): Promise<void> {
  try {
    const order = await OrderModel.findByOrderNumber(req.params.orderNumber);
    // Return limited fields for customer-facing tracking
    res.json({
      success: true,
      data: {
        order_number:     order.order_number,
        status:           order.status,
        status_updated_at:order.status_updated_at,
        customer_name:    order.customer_name,
        customer_city:    order.customer_city,
        total_lyd:        order.total_lyd,
        created_at:       order.created_at,
        items:            order.items?.map((i) => ({
          product_name:  i.product_name,
          variant_label: i.variant_label,
          quantity:      i.quantity,
          line_total_lyd:i.line_total_lyd,
        })),
      },
    });
  } catch (err) { next(err); }
}

// ── PATCH /api/orders/:id/status ─────────────────────────────────────────
export async function updateOrderStatus(
  req: Request<{ id: string }>, res: Response, next: NextFunction
): Promise<void> {
  try {
    const { status, admin_notes } = req.body as {
      status: OrderStatus;
      admin_notes?: string;
    };

    const VALID: OrderStatus[] = [
      "placed","pending","confirmed","purchased","shipped","delivered","cancelled",
    ];
    if (!VALID.includes(status)) {
      throw new AppError(`Invalid status: ${status}`, 400, "VALIDATION_ERROR");
    }

    const order = await OrderModel.updateStatus(req.params.id, status, admin_notes);
    res.json({ success: true, message: `Order status updated to ${status}`, data: order });
  } catch (err) { next(err); }
}
