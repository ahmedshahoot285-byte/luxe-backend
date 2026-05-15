import { Request, Response, NextFunction } from "express";

/**
 * Attaches the real client IP to req.clientIp.
 * Reads X-Forwarded-For (set by Render/Vercel/nginx), falls back to socket.
 */
export function extractIp(req: Request, _res: Response, next: NextFunction): void {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]
      .trim();
    req.clientIp = first || req.socket.remoteAddress;
  } else {
    req.clientIp = req.socket.remoteAddress;
  }
  next();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      clientIp?: string;
    }
  }
}
