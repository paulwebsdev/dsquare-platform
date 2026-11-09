import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const lockName = "dsquare-d-hosting-schema-migrations";

function compareMigrations(left: string, right: string): number {
  const leftNumber = Number(left.slice(0, 3));
  const rightNumber = Number(right.slice(0, 3));

  if (leftNumber !== rightNumber) return leftNumber - rightNumber;

  // Both files were historically numbered 002. Resources must exist before
  // files because hosting_files has a foreign key to hosting_resources.
  if (leftNumber === 2) {
    const priority = (name: string) =>
      name.includes("create_hosting_resources") ? 0 :
      name.includes("create_hosting_files") ? 1 : 2;
    return priority(left) - priority(right) || left.localeCompare(right);
  }

  return left.localeCompare(right);
}

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
      .sort(compareMigrations);

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
        console.log(`D Hosting migration applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`D Hosting migration database error (${file}):`, error);
        throw new Error(`D Hosting migration failed (${file}).`, { cause: error });
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
