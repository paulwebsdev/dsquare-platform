import assert from "node:assert/strict";
import testRunner from "node:test";
import { createResourceAccessPlan } from "./resource-access-policy.js";

const resourceId = "09800acb-a6c6-42d0-93f0-9d8aa73c251d";

testRunner("creates a unique least-privilege login scoped to one resource schema", () => {
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  });

  assert.equal(plan.roleName, "dsq_app_09800acba6c642d093f09d8aa73c251d");
  assert.match(plan.password, /^[A-Za-z0-9_-]{43}$/);
  assert.match(plan.createRole, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  assert.ok(plan.grantStatements.some((sql) => sql.includes('ON SCHEMA "db_09800acba6c642d093f09d8aa73c251d"')));
  assert.ok(plan.grantStatements.every((sql) => !sql.includes("ON SCHEMA public")));
  assert.match(plan.disableRole, /NOLOGIN/);
});

testRunner("rejects malformed resource and schema identifiers", () => {
  assert.throws(() => createResourceAccessPlan({
    resourceId: "not-a-uuid",
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  }));
  assert.throws(() => createResourceAccessPlan({
    resourceId,
    schemaName: 'db_x"; DROP SCHEMA public; --',
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  }));
  assert.throws(() => createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "bad-name",
    schemaOwner: "d_database_app",
  }));
});

testRunner("generates different credentials for separate provisioning attempts", () => {
  const input = {
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  };
  assert.notEqual(
    createResourceAccessPlan(input).password,
    createResourceAccessPlan(input).password,
  );
});
