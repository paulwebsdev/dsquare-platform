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

testRunner("limits every grant to the resource schema and required data operations", () => {
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  });

  assert.equal(plan.grantStatements.length, 7);
  assert.ok(plan.grantStatements.every((sql) =>
    sql.includes('"db_09800acba6c642d093f09d8aa73c251d"') ||
    sql.includes('ON DATABASE "d_database"'),
  ));
  assert.ok(plan.grantStatements.every((sql) =>
    !/\\b(CREATE|TRUNCATE|REFERENCES|TRIGGER|GRANT OPTION)\\b|\\bTO PUBLIC\\b/i.test(sql),
  ));
  assert.ok(plan.grantStatements.some((sql) =>
    /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA/.test(sql),
  ));
  assert.ok(plan.grantStatements.some((sql) =>
    /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA/.test(sql),
  ));
});

testRunner("configures server-enforced connection and query limits on each resource role", () => {
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
  });
  assert.ok(plan.configureStatements.some((sql) => /CONNECTION LIMIT 5/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /statement_timeout = '30000ms'/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /lock_timeout = '5000ms'/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /idle_in_transaction_session_timeout = '30000ms'/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /search_path|application_name/.test(sql)) === false);
  assert.ok(plan.configureStatements.some((sql) => /application_name = 'dsquare-resource-09800acba6c642d093f09d8aa73c251d'/.test(sql)));
});

testRunner("applies operator-configured values only after numeric bounds validation", () => {
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
    limits: {
      connectionLimit: 8,
      statementTimeoutMs: 45_000,
      lockTimeoutMs: 3_000,
      idleInTransactionSessionTimeoutMs: 20_000,
    },
  });
  assert.ok(plan.configureStatements.some((sql) => /CONNECTION LIMIT 8/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /statement_timeout = '45000ms'/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /lock_timeout = '3000ms'/.test(sql)));
  assert.ok(plan.configureStatements.some((sql) => /idle_in_transaction_session_timeout = '20000ms'/.test(sql)));
  assert.throws(() => createResourceAccessPlan({
    resourceId,
    schemaName: "db_09800acba6c642d093f09d8aa73c251d",
    databaseName: "d_database",
    schemaOwner: "d_database_app",
    limits: { connectionLimit: 500, statementTimeoutMs: 30_000, lockTimeoutMs: 5_000, idleInTransactionSessionTimeoutMs: 30_000 },
  }), /Invalid resource access connection limit/);
});
