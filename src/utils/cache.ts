/**
 * Lightweight in-memory TTL cache.
 * For multi-instance deployments, swap the store for Redis.
 *
 * Eviction:
 *  - On get() — expired entries are removed immediately.
 *  - Periodic — a cleanup interval removes all expired entries every 5 minutes.
 *  - Cap — when the live entry count exceeds MAX_ENTRIES, the oldest-expiring
 *    entries are evicted to keep memory bounded.
 */

interface Entry<T> {
  value:     T;
  expiresAt: number;
}

const MAX_ENTRIES      = 2_000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 min

class MemoryCache {
  private store = new Map<string, Entry<unknown>>();

  constructor() {
    // Proactive cleanup — prevents unbounded growth from many distinct filter combos
    const timer = setInterval(() => this._purgeExpired(), CLEANUP_INTERVAL);
    // Don't keep the process alive just for cache cleanup
    if (timer.unref) timer.unref();
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key) as Entry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Evict if over cap (remove earliest-expiring entries first)
    if (this.store.size >= MAX_ENTRIES) {
      this._evictOldest(Math.floor(MAX_ENTRIES * 0.1)); // drop ~10%
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  /** Remove all keys that start with the given prefix */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Current number of live (non-expired) entries */
  get size(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.store.values()) {
      if (entry.expiresAt > now) count++;
    }
    return count;
  }

  private _purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private _evictOldest(count: number): void {
    // Sort by expiresAt ascending — soonest-to-expire entries are evicted first
    const sorted = [...this.store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < count && i < sorted.length; i++) {
      this.store.delete(sorted[i][0]);
    }
  }
}

// Single shared instance for the whole process
export const cache = new MemoryCache();

// ── Common TTLs ────────────────────────────────────────────────────────────
export const TTL = {
  SETTINGS:  10 * 60 * 1000,  // 10 min — pricing config, exchange rate
  PRODUCTS:   2 * 60 * 1000,  // 2 min  — product list pages
  PRODUCT:    5 * 60 * 1000,  // 5 min  — single product (slug / id lookup)
  BRANDS:    30 * 60 * 1000,  // 30 min — brand / category lists (rarely change)
} as const;
