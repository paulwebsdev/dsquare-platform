import assert from "node:assert/strict";
import testRunner from "node:test";
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
