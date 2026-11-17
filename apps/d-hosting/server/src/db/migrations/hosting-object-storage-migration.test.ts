import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("./021_create_hosting_object_blobs.sql", import.meta.url);

test("PostgreSQL website object migration stores scoped, size-limited binary objects", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS hosting_object_blobs/);
  assert.match(sql, /owner_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /project_id UUID NOT NULL REFERENCES projects\(id\) ON DELETE CASCADE/);
  assert.match(sql, /resource_id UUID NOT NULL REFERENCES hosting_resources\(id\) ON DELETE CASCADE/);
  assert.match(sql, /body BYTEA NOT NULL/);
  assert.match(sql, /size_bytes BIGINT NOT NULL CHECK \(size_bytes > 0 AND size_bytes <= 10485760\)/);
  assert.match(sql, /octet_length\(body\) = size_bytes/);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON TABLE hosting_object_blobs TO d_hosting_app/);
});
