import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), "017_database_connection_limit.sql"),
  "utf8",
);

test("adds a non-null bounded database connection budget for existing and new links", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS database_connection_limit INTEGER NOT NULL DEFAULT 5/);
  assert.match(migration, /CHECK \(database_connection_limit BETWEEN 1 AND 50\)/);
});
