import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = await readFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "020_grant_hosting_project_resource_permissions.sql",
  ),
  "utf8",
);

test("grants the Hosting application role access to projects and website resources", () => {
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app'\)/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects, hosting_resources TO d_hosting_app/,
  );
});
