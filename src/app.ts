import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import productsRouter    from "./routes/products.routes";
import categoriesRouter  from "./routes/categories.routes";
import importRouter      from "./routes/import.routes";
import ordersRouter      from "./routes/orders.routes";
import settingsRouter    from "./routes/settings.routes";
import syncRouter        from "./routes/sync.routes";
import backupRouter      from "./routes/backup.routes";
import { errorHandler } from "./middleware/error.middleware";

const app = express();

// ── Security ───────────────────────────────────────────────────────────────
app.use(helmet());
// In development, accept any localhost origin so the port doesn't matter.
// In production, restrict to the configured FRONTEND_URL.
const allowedOrigin = process.env.FRONTEND_URL ?? "http://localhost:3000";
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    // Production: exact match
    if (origin === allowedOrigin) return callback(null, true);
    // Development: allow any localhost regardless of port
    if (process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down." },
}));

// ── Body parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use("/api/products",   productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/import",     importRouter);
app.use("/api/orders",   ordersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/sync",     syncRouter);
app.use("/api/backups",  backupRouter);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// ── Global error handler ───────────────────────────────────────────────────
app.use(errorHandler);

export default app;
