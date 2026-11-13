import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  assertMigrationChecksum,
  getMigrationChecksum,
  validateMigrationFilenames,
} from "./migration-integrity.js";

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
    await client.query(
      "CREATE TABLE IF NOT EXISTS dsquare_schema_migrations (" +
        "name TEXT PRIMARY KEY, checksum CHAR(64), applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    await client.query(
      "ALTER TABLE dsquare_schema_migrations ADD COLUMN IF NOT EXISTS checksum CHAR(64)",
    );

    const files = validateMigrationFilenames(
      (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")),
    );
    const migrations = await Promise.all(files.map(async (file) => {
      const rawSql = await readFile(resolve(migrationsDirectory, file), "utf8");
      return { file, rawSql, checksum: getMigrationChecksum(rawSql) };
    }));

    const appliedResult = await client.query(
      "SELECT name, checksum FROM dsquare_schema_migrations",
    );
    const applied = new Map(
      (appliedResult.rows as Array<{ name: string; checksum: string | null }>)
        .map((row) => [row.name, row.checksum]),
    );
    const available = new Set(files);

    for (const appliedName of applied.keys()) {
      if (!available.has(appliedName)) {
        throw new Error(
          "Applied D Database migration is missing from the migration directory: " + appliedName,
        );
      }
    }

    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.file);
      if (applied.has(migration.file)) {
        assertMigrationChecksum(migration.file, migration.checksum, previousChecksum);
        if (previousChecksum === null) {
          // Adopt the current contents once for migrations recorded before checksum tracking existed.
          await client.query(
            "UPDATE dsquare_schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL",
            [migration.file, migration.checksum],
          );
        }
        continue;
      }

      const sql = removeTransactionWrappers(migration.rawSql);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO dsquare_schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.file, migration.checksum],
        );
        await client.query("COMMIT");
        console.log("D Database migration applied: " + migration.file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error("D Database migration failed (" + migration.file + ").", { cause: error });
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
