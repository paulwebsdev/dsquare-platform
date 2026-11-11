import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import testRunner from "node:test";

testRunner("resource access migration grants metadata access to the application role", async () => {
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "007_resource_access_grants.sql",
  );
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS resource_access_grants/i);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON TABLE resource_access_grants TO d_database_app/i,
  );
  assert.doesNotMatch(sql, /GRANT ALL|GRANT .* TO PUBLIC/i);
});
