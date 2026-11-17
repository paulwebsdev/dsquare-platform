import assert from "node:assert/strict";
import test from "node:test";
import { deferMissingDatabaseAppGrants } from "./migrate.js";

test("keeps database app grants when the role exists", () => {
  const sql = "CREATE TABLE sample (id integer);\nGRANT SELECT ON sample TO d_database_app;";
  const result = deferMissingDatabaseAppGrants(sql, true);
  assert.equal(result.sql, sql);
  assert.equal(result.deferredCount, 0);
});

test("defers only d_database_app grants when the role is missing", () => {
  const sql = [
    "-- table setup",
    "CREATE TABLE sample (id integer);",
    "-- the restricted role receives access after DBA provisioning",
    "GRANT SELECT, INSERT ON TABLE sample TO d_database_app;",
    "CREATE INDEX sample_id_idx ON sample (id);",
  ].join("\n");
  const result = deferMissingDatabaseAppGrants(sql, false);
  assert.equal(result.deferredCount, 1);
  assert.match(result.sql, /CREATE TABLE sample/);
  assert.match(result.sql, /CREATE INDEX sample_id_idx/);
  assert.doesNotMatch(result.sql, /GRANT .* TO d_database_app/);
});
