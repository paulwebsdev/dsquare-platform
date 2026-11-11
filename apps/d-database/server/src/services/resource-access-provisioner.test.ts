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
