import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrimaryKeyCursorQuery,
  decodePrimaryKeyCursor,
  encodePrimaryKeyCursor,
  CursorValidationError,
} from "./cursor-pagination.js";

const schema = `db_${"a".repeat(32)}`;

test("encodes and decodes typed primary-key cursor values", () => {
  for (const value of ["row-123", 42, true]) {
    assert.deepEqual(decodePrimaryKeyCursor(encodePrimaryKeyCursor(value)), value);
  }
  const timestamp = new Date("2026-11-13T12:00:00.000Z");
  assert.equal(decodePrimaryKeyCursor(encodePrimaryKeyCursor(timestamp)), timestamp.toISOString());
});

test("builds deterministic first and next keyset pages", () => {
  const first = buildPrimaryKeyCursorQuery({ schemaName: schema, tableName: "customers", primaryKey: "id", limit: 25 });
  assert.equal(first.text, `SELECT * FROM "${schema}"."customers" ORDER BY "id" ASC LIMIT $1`);
  assert.deepEqual(first.values, [26]);

  const next = buildPrimaryKeyCursorQuery({ schemaName: schema, tableName: "customers", primaryKey: "id", limit: 25, cursor: encodePrimaryKeyCursor("row-25") });
  assert.equal(next.text, `SELECT * FROM "${schema}"."customers" WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2`);
  assert.deepEqual(next.values, ["row-25", 26]);
});

test("rejects malformed cursors, invalid identifiers and unsafe limits", () => {
  assert.throws(() => decodePrimaryKeyCursor("not a cursor"), CursorValidationError);
  assert.throws(() => buildPrimaryKeyCursorQuery({ schemaName: schema, tableName: "customers;drop", primaryKey: "id", limit: 10 }), CursorValidationError);
  assert.throws(() => buildPrimaryKeyCursorQuery({ schemaName: schema, tableName: "customers", primaryKey: "id", limit: 101 }), CursorValidationError);
});
