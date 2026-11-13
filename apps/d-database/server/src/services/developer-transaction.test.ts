import assert from "node:assert/strict";
import test from "node:test";
import { executeDeveloperTransaction, DeveloperTransactionValidationError } from "./developer-transaction.js";

const schema = `db_${"a".repeat(32)}`;
function fakeClient(options: { missingTable?: boolean } = {}) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.includes("information_schema.columns")) {
        return { rows: options.missingTable ? [] : [{ column_name: "id" }, { column_name: "name" }], rowCount: options.missingTable ? 0 : 2 };
      }
      return { rows: [{ id: "1", name: "Ada" }], rowCount: 1 };
    },
  };
}

test("runs multiple scoped insert, update and delete operations in order", async () => {
  const client = fakeClient();
  const results = await executeDeveloperTransaction(client as never, schema, [
    { type: "insert", table: "customers", values: { id: "1", name: "Ada" } },
    { type: "update", table: "customers", values: { name: "Grace" }, where: { id: "1" } },
    { type: "delete", table: "customers", where: { id: "1" } },
  ]);
  assert.deepEqual(results.map((item) => item.type), ["insert", "update", "delete"]);
  assert.equal(client.calls.filter((call) => call.text.includes("information_schema.columns")).length, 3);
  assert.match(client.calls[1].text, /UPDATE "db_[a-f0-9]{32}"\."customers" SET "name" = \$1 WHERE "id" = \$2/);
  assert.deepEqual(client.calls[1].values, ["Grace", "1"]);
  assert.match(client.calls[2].text, /DELETE FROM "db_[a-f0-9]{32}"\."customers" WHERE "id" = \$1/);
});

test("rejects invalid schema scope, empty filters, too many operations and unsafe names", async () => {
  const client = fakeClient();
  await assert.rejects(executeDeveloperTransaction(client as never, "public", [{ type: "delete", table: "customers", where: { id: "1" } }]), DeveloperTransactionValidationError);
  await assert.rejects(executeDeveloperTransaction(client as never, schema, [{ type: "delete", table: "customers", where: {} }]), DeveloperTransactionValidationError);
  await assert.rejects(executeDeveloperTransaction(client as never, schema, Array.from({ length: 21 }, () => ({ type: "delete", table: "customers", where: { id: "1" } }))), DeveloperTransactionValidationError);
  await assert.rejects(executeDeveloperTransaction(client as never, schema, [{ type: "insert", table: "customers; DROP TABLE users", values: { id: "1" } }]), DeveloperTransactionValidationError);
  assert.equal(client.calls.length, 0);
});

test("rejects missing tables and columns before writing", async () => {
  const missing = fakeClient({ missingTable: true });
  await assert.rejects(executeDeveloperTransaction(missing as never, schema, [{ type: "insert", table: "missing", values: { id: "1" } }]), /not found/);
  const client = fakeClient();
  await assert.rejects(executeDeveloperTransaction(client as never, schema, [{ type: "insert", table: "customers", values: { password: "x" } }]), /column that does not exist/);
  assert.equal(client.calls.filter((call) => call.text.startsWith("INSERT")).length, 0);
});
