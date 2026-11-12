import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("developer API key migration enforces resource ownership metadata and least privilege", async () => {
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "008_developer_api_keys.sql",
  );
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS developer_api_keys/i);
  assert.match(sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /project_id UUID NOT NULL REFERENCES projects\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /resource_id UUID NOT NULL REFERENCES database_resources\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /token_hash CHAR\(64\) NOT NULL UNIQUE/i);
  assert.match(sql, /revoked_at TIMESTAMPTZ/i);
  assert.match(sql, /expires_at TIMESTAMPTZ/i);
  assert.match(sql, /scopes <@ ARRAY\['read', 'write'\]::TEXT\[\]/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE developer_api_keys TO d_database_app/i);
  assert.doesNotMatch(sql, /GRANT ALL|GRANT .* TO PUBLIC/i);
});
