import assert from "node:assert/strict";
import testRunner from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const provisionerSource = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), "resource-access-provisioner.ts"),
  "utf8",
);
import { createResourceAccessPlan } from "./resource-access-policy.js";

testRunner("resource role plan does not grant schema creation or elevated role powers", () => {
  const plan = createResourceAccessPlan({
    resourceId: "09800acb-a6c6-42d0-93f0-9d8aa73c251d",
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  });
  assert.match(plan.createRole, /LOGIN PASSWORD/);
  assert.match(plan.createRole, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  assert.ok(plan.grantStatements.every((statement) => !/CREATE ON SCHEMA|GRANT ALL/i.test(statement)));
  assert.ok(plan.grantStatements.some((statement) => /ALTER DEFAULT PRIVILEGES FOR ROLE "d_database_app"/.test(statement)));
});


testRunner("provisioning rejects a provisioner connection to a different database", () => {
  assert.match(provisionerSource, /provisionerDatabaseName !== databaseName/);
  assert.match(provisionerSource, /Provisioner connection points to a different database/);
});

testRunner("provisioning verifies schema ownership through the provisioner connection", () => {
  assert.match(provisionerSource, /const provisionerOwnerResult = await client\.query/);
  assert.match(provisionerSource, /provisionerSchemaOwner !== "d_database_app"/);
  assert.match(provisionerSource, /Provisioner database resource schema ownership does not match/);
});


testRunner("resource access plans reject unsafe database and schema-owner identifiers", () => {
  const base = {
    resourceId: "09800acb-a6c6-42d0-93f0-9d8aa73c251d",
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  };
  assert.throws(
    () => createResourceAccessPlan({ ...base, databaseName: 'd_database"; DROP DATABASE postgres; --' }),
    /Invalid PostgreSQL identifier/,
  );
  assert.throws(
    () => createResourceAccessPlan({ ...base, schemaOwner: "public; GRANT ALL" }),
    /Invalid PostgreSQL identifier/,
  );
  assert.throws(
    () => createResourceAccessPlan({ ...base, schemaName: "public" }),
    /Invalid resource schema/,
  );
});

testRunner("resource access passwords are SQL-safe high-entropy URL-safe values", () => {
  const plan = createResourceAccessPlan({
    resourceId: "09800acb-a6c6-42d0-93f0-9d8aa73c251d",
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  });
  assert.match(plan.password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(plan.password.includes(String.fromCharCode(39)), false);
});

testRunner("resource revocation disables login, terminates sessions, and commits metadata atomically", () => {
  assert.match(provisionerSource, /ALTER ROLE "\$\{roleName\}" NOLOGIN/);
  assert.match(provisionerSource, /pg_terminate_backend\(pid\)/);
  assert.match(provisionerSource, /status = 'revoked', revoked_at = NOW\(\)/);
  assert.match(provisionerSource, /await client\.query\("BEGIN"\)/);
  assert.match(provisionerSource, /await client\.query\("COMMIT"\)/);
  assert.match(provisionerSource, /await client\.query\("ROLLBACK"\)/);
});

testRunner("resource provisioning serializes grant metadata and rolls back failed grants", () => {
  assert.match(provisionerSource, /FOR UPDATE/);
  assert.match(provisionerSource, /ON CONFLICT \(resource_id\) DO UPDATE/);
  assert.match(provisionerSource, /catch \(error\)[\s\S]*?ROLLBACK/);
});
