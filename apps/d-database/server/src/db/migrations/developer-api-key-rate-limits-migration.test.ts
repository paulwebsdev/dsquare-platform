import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("per-key API rate-limit migration isolates counters and grants only required access", async () => {
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "009_developer_api_key_rate_limits.sql",
  );
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /key_id UUID PRIMARY KEY REFERENCES developer_api_keys\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /request_count INTEGER NOT NULL DEFAULT 0 CHECK \(request_count >= 0\)/i);
  assert.match(sql, /REVOKE ALL ON TABLE developer_api_key_rate_limits FROM PUBLIC/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE developer_api_key_rate_limits TO d_database_app/i);
  assert.doesNotMatch(sql, /GRANT ALL|GRANT .* TO PUBLIC/i);
});
