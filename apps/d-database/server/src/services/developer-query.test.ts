import assert from "node:assert/strict";
import test from "node:test";
import { buildDeveloperDeleteQuery, buildDeveloperUpdateQuery } from "./developer-query.js";

const allowed = new Set(["id", "name", "email"]);

test("builds parameterized update statements with mandatory filters", () => {
  const query = buildDeveloperUpdateQuery({
    schemaName: "db_" + "a".repeat(32),
    tableName: "customers",
    allowedColumns: allowed,
    values: { name: "Ada" },
    where: { id: "customer-1", email: "ada@example.com" },
  });
  assert.match(query.text, /^UPDATE "db_[a-f]{32}"\."customers" SET "name" = \$1 WHERE "id" = \$2 AND "email" = \$3 RETURNING \*$/);
  assert.deepEqual(query.values, ["Ada", "customer-1", "ada@example.com"]);
});

test("builds parameterized delete statements", () => {
  const query = buildDeveloperDeleteQuery({
    schemaName: "db_" + "b".repeat(32),
    tableName: "customers",
    allowedColumns: allowed,
    where: { id: "customer-1" },
  });
  assert.equal(query.text, 'DELETE FROM "db_' + "b".repeat(32) + '"."customers" WHERE "id" = $1 RETURNING *');
  assert.deepEqual(query.values, ["customer-1"]);
});

test("rejects empty filters to prevent whole-table mutations", () => {
  assert.throws(() => buildDeveloperDeleteQuery({
    schemaName: "db_" + "a".repeat(32),
    tableName: "customers",
    allowedColumns: allowed,
    where: {},
  }), /invalid columns/i);
  assert.throws(() => buildDeveloperUpdateQuery({
    schemaName: "db_" + "a".repeat(32),
    tableName: "customers",
    allowedColumns: allowed,
    values: { name: "Ada" },
    where: {},
  }), /invalid columns/i);
});

test("rejects unknown and injected column names", () => {
  assert.throws(() => buildDeveloperUpdateQuery({
    schemaName: "db_" + "a".repeat(32),
    tableName: "customers",
    allowedColumns: allowed,
    values: { "name = 'x'; DROP TABLE customers": "Ada" },
    where: { id: "customer-1" },
  }), /invalid columns/i);
});
