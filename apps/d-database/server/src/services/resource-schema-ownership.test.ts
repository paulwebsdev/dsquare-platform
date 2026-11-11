import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import testRunner from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));

testRunner("new resource schemas are explicitly owned by d_database_app", async () => {
  const source = await readFile(
    resolve(directory, "../routes/database-resources.ts"),
    "utf8",
  );
  assert.match(
    source,
    /CREATE SCHEMA ["']\$\{schemaName\}["'] AUTHORIZATION d_database_app/,
  );
});

testRunner("runtime provisioning verifies the actual resource schema owner", async () => {
  const source = await readFile(
    resolve(directory, "resource-access-provisioner.ts"),
    "utf8",
  );
  assert.match(source, /FROM pg_namespace AS namespace/);
  assert.match(source, /JOIN pg_roles AS owner ON owner\.oid = namespace\.nspowner/);
  assert.match(source, /schemaOwner !== "d_database_app"/);
  assert.match(source, /schemaOwner,/);
});
