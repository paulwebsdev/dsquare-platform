import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const lockName = "dsquare-d-database-schema-migrations";

function removeTransactionWrappers(sql: string): string {
  return sql
    .replace(/^\uFEFF/, "")
    .replace(/^\s*BEGIN\s*;\s*/i, "")
    .replace(/\s*COMMIT\s*;\s*$/i, "");
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dsquare_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM dsquare_schema_migrations WHERE name = $1",
        [file]
      );
      if (alreadyApplied.rowCount) continue;

      const sql = removeTransactionWrappers(
        await readFile(resolve(migrationsDirectory, file), "utf8")
      );

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO dsquare_schema_migrations (name) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`D Database migration applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`D Database migration failed (${file}).`, { cause: error });
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
    } finally {
      client.release();
    }
  }
}
