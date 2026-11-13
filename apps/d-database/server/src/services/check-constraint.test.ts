import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckConstraintSql, CheckConstraintValidationError } from "./check-constraint.js";

const schema = `db_${"c".repeat(32)}`;

test("builds safe check constraints for text, numeric and boolean values", () => {
  assert.equal(
    buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "age_positive", column: "age", operator: ">=", value: 18 }),
    `ALTER TABLE "${schema}"."customers" ADD CONSTRAINT "age_positive" CHECK ("age" >= 18)`,
  );
  assert.match(buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "name_required", column: "name", operator: "<>", value: "" }), /CHECK \("name" <> ''\)$/);
  assert.match(buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "active_true", column: "active", operator: "=", value: true }), /CHECK \("active" = TRUE\)$/);
});

test("escapes string literals and rejects arbitrary SQL fragments", () => {
  const sql = buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "safe_name", column: "name", operator: "=", value: "' OR TRUE --" });
  assert.ok(sql.endsWith(`CHECK ("name" = ''' OR TRUE --')`));
  assert.throws(() => buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "bad", column: "age", operator: ") OR TRUE --", value: 1 }), CheckConstraintValidationError);
  assert.throws(() => buildCheckConstraintSql({ schemaName: schema, tableName: "customers", constraintName: "bad", column: "age", operator: ">", value: { raw: "sql" } }), CheckConstraintValidationError);
});
