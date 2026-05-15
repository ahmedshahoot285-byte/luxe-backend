import { Pool, PoolClient, QueryResultRow } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10_000,   // Supabase drops idle connections, recycle fast
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("Unexpected PG client error:", err);
});

export const db = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
    pool.query<T>(text, params),

  transaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      // 30-second hard limit per transaction so a stalled Playwright scrape
      // doesn't hold a connection from the pool indefinitely.
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  end: () => pool.end(),
};
