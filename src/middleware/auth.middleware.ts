import { Request, Response, NextFunction } from "express";

/**
 * Protect admin routes with a shared secret token.
 * Set ADMIN_SECRET in your .env file.
 * Clients send: Authorization: Bearer <token>
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.ADMIN_SECRET;

  // In development with no secret configured, warn but allow through
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      res.status(500).json({ success: false, error: "Server misconfigured: ADMIN_SECRET not set" });
      return;
    }
    // dev-only: log a loud warning but don't block
    console.warn("⚠  ADMIN_SECRET not set — admin endpoints are unprotected (dev mode only)");
    next();
    return;
  }

  const header = req.headers["authorization"] ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();

  if (!token || token !== secret) {
    res.status(401).json({ success: false, error: "Unauthorized", code: "UNAUTHORIZED" });
    return;
  }

  next();
}
