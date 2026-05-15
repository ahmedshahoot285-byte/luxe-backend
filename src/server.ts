import "dotenv/config";
import app from "./app";
import { db } from "./db";
import { startImportWorker, closeQueue } from "./services/queue.service";
import { closeBrowser } from "./services/scraper.service";
import { warmExchangeRate } from "./services/exchange.service";
import { startSyncScheduler, stopSyncScheduler }     from "./services/sync.service";
import { startBackupScheduler, stopBackupScheduler, recoverStaleBackups } from "./services/backup.service";

const PORT = process.env.PORT ?? 4000;

async function start() {
  // Verify DB connection before accepting traffic
  await db.query("SELECT 1");
  console.log("✓ Database connected");

  // Start BullMQ worker (no-op if Redis not configured)
  startImportWorker();

  // Warm exchange rate cache (background — doesn't block startup)
  warmExchangeRate();

  // Start daily sync scheduler (runs at 02:00 every day)
  startSyncScheduler();

  // Recover any backups orphaned by a previous restart, then start scheduler
  await recoverStaleBackups();
  startBackupScheduler();

  const server = app.listen(PORT, () => {
    console.log(`✓ Server running at http://localhost:${PORT}`);
    console.log(`  Health:   http://localhost:${PORT}/health`);
    console.log(`  Products: http://localhost:${PORT}/api/products`);
    console.log(`  Import:   http://localhost:${PORT}/api/import`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully`);
    stopSyncScheduler();    // cancel pending scheduler timers first
    stopBackupScheduler();
    server.close(async () => {
      await closeQueue();
      await closeBrowser();
      await db.end();
      console.log("✓ Shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
