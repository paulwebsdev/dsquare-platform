import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckConstraintSql } from "./table-check-constraint.js";

const schema = `db_${"a".repeat(32)}`;

test("builds named check constraints with escaped string values", () => {
  const sql = buildCheckConstraintSql({
    schemaName: schema, tableName: "customers", constraintName: "age_minimum",
    columnName: "status", operator: "=", value: "customer's active",
  });
  assert.match(sql, /CHECK \("status" = 'customer''s active'\)$/);
});

test("supports numeric and boolean check values", () => {
  assert.match(buildCheckConstraintSql({
    schemaName: schema, tableName: "orders", constraintName: "amount_positive",
    columnName: "amount", operator: ">=", value: 0,
  }), /"amount" >= 0/);
  assert.match(buildCheckConstraintSql({
    schemaName: schema, tableName: "flags", constraintName: "enabled_true",
    columnName: "enabled", operator: "=", value: true,
  }), /"enabled" = TRUE/);
});

test("rejects unsafe identifiers, operators, null and non-finite values", () => {
  const base = { schemaName: schema, tableName: "customers", constraintName: "safe_check", columnName: "age", operator: ">", value: 0 };
  assert.throws(() => buildCheckConstraintSql({ ...base, operator: ">; DROP TABLE users" }), /Invalid check constraint/);
  assert.throws(() => buildCheckConstraintSql({ ...base, columnName: "age) OR TRUE --" }), /Invalid check constraint/);
  assert.throws(() => buildCheckConstraintSql({ ...base, value: Number.NaN }), /require a string/);
  assert.throws(() => buildCheckConstraintSql({ ...base, value: null }), /require a string/);
});
