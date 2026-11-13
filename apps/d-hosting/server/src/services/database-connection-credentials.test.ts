import assert from "node:assert/strict";
import test from "node:test";
import { isValidDatabaseConnectionCredentials } from "./database-connection-credentials.js";

const valid = {
  user_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "33333333-3333-4333-8333-333333333333",
  resource_name: "Customer Data",
  schema_name: "db_09800acba6c642d093f09d8aa73c2515",
  database_host: "database.internal",
  database_port: 5432,
  database_name: "d_database",
  database_role: "dsq_app_33333333333343338333333333333333",
  database_password: "A".repeat(43),
  database_connection_limit: 5,
};

test("accepts a complete scoped database credential response", () => {
  assert.equal(isValidDatabaseConnectionCredentials(valid), true);
});

test("rejects malformed identities and resource schemas", () => {
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, user_id: "not-a-uuid" }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, schema_name: "public" }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_role: "postgres" }), false);
});

test("rejects unsafe database endpoints and invalid ports", () => {
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_host: "db.internal/other" }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_host: "db.internal" + String.fromCharCode(10) }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_host: "db.internal\\n" }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_port: 70000 }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_port: 0 }), false);
});

test("rejects missing names and malformed passwords", () => {
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, resource_name: "  " }), false);
  assert.equal(isValidDatabaseConnectionCredentials({ ...valid, database_password: "short" }), false);
  assert.equal(isValidDatabaseConnectionCredentials(null), false);
});
