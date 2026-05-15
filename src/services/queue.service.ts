import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { importFromUrl } from "./importer.service";

// ── Redis connection ───────────────────────────────────────────────────────
// Falls back to a no-op in-memory mode if Redis is unavailable.

let redisConnection: IORedis | null = null;

function getRedis(): IORedis | null {
  if (!process.env.REDIS_URL) return null;
  if (redisConnection) return redisConnection;
  try {
    redisConnection = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    return redisConnection;
  } catch {
    return null;
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────

export const IMPORT_QUEUE = "product-import";

let importQueue: Queue | null = null;

export function getImportQueue(): Queue | null {
  const redis = getRedis();
  if (!redis) return null;
  if (!importQueue) {
    importQueue = new Queue(IMPORT_QUEUE, { connection: redis });
  }
  return importQueue;
}

// ── Job data shape ────────────────────────────────────────────────────────

export interface ImportJobData {
  url:       string;
  importId:  string;
}

// ── Add job to queue ──────────────────────────────────────────────────────

export async function enqueueImport(data: ImportJobData): Promise<string | null> {
  const queue = getImportQueue();
  if (!queue) return null;   // Redis unavailable — caller will run inline
  const job = await queue.add("import", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  });
  return job.id ?? null;
}

// ── Worker (started separately — see startWorker()) ──────────────────────

let worker: Worker | null = null;

export function startImportWorker(): void {
  const redis = getRedis();
  if (!redis) {
    console.log("⚠  Redis not configured — import queue disabled, running inline");
    return;
  }

  worker = new Worker<ImportJobData>(
    IMPORT_QUEUE,
    async (job: Job<ImportJobData>) => {
      console.log(`[queue] processing import job ${job.id}: ${job.data.url}`);
      const result = await importFromUrl(job.data.url, job.data.importId);
      console.log(`[queue] job ${job.id} → ${result.status}`);
      return result;
    },
    {
      connection: redis,
      concurrency: 2,   // run up to 2 scrapes in parallel
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[queue] job ${job?.id} failed:`, err.message);
  });

  console.log("✓ Import queue worker started");
}

export async function closeQueue(): Promise<void> {
  await worker?.close();
  await importQueue?.close();
  await redisConnection?.quit();
}
