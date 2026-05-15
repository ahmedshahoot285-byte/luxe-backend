/**
 * Minimal migration runner.
 * Run:  npx ts-node src/db/migrate.ts
 *
 * Tracks applied migrations in a `_migrations` table so each file
 * runs exactly once, in filename order.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { db } from "./index";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function run() {
  // Ensure tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await db.query<{ filename: string }>(
    "SELECT filename FROM _migrations ORDER BY filename"
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`  → applying ${file}`);

    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    });
    ran++;
  }

  console.log(ran === 0 ? "Nothing to migrate." : `Done. Applied ${ran} migration(s).`);
  await db.end();
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
