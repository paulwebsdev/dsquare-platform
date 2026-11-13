import assert from "node:assert/strict";
import test from "node:test";
import { executeDeveloperTransaction, DeveloperTransactionValidationError } from "./developer-transaction.js";

function mockClient(options: { failOn?: string } = {}) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("information_schema.columns")) {
        if (values?.[1] === "missing") return { rows: [], rowCount: 0 };
        return { rows: ["id", "name", "email"].map(column_name => ({ column_name })), rowCount: 3 };
      }
      if (options.failOn && text.startsWith(options.failOn)) throw new Error("simulated statement failure");
      return { rows: [{ id: "row-1", name: "Ada" }], rowCount: 1 };
    },
  };
  return { client, calls };
}

const schema = `db_${"a".repeat(32)}`;

test("executes insert, update and delete sequentially using one client", async () => {
  const mock = mockClient();
  const result = await executeDeveloperTransaction(mock.client as never, schema, [
    { type: "insert", table: "customers", values: { name: "Ada" } },
    { type: "update", table: "customers", values: { name: "Grace" }, where: { id: "row-1" } },
    { type: "delete", table: "customers", where: { id: "row-2" } },
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(item => item.affectedCount), [1, 1, 1]);
  assert.equal(mock.calls.filter(call => !call.text.includes("information_schema.columns")).length, 3);
});

test("rejects empty, oversized and unsafe transaction requests", async () => {
  const mock = mockClient();
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, []), DeveloperTransactionValidationError);
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, Array.from({ length: 21 }, () => ({ type: "delete", table: "customers", where: { id: "1" } }))), DeveloperTransactionValidationError);
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, [{ type: "delete", table: "customers;drop", where: { id: "1" } }]), DeveloperTransactionValidationError);
});

test("rejects missing tables, unknown columns and unfiltered mutations", async () => {
  const mock = mockClient();
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, [{ type: "insert", table: "missing", values: { name: "Ada" } }]), /Table not found/);
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, [{ type: "insert", table: "customers", values: { password: "x" } }]), /invalid columns/i);
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, [{ type: "delete", table: "customers", where: {} }]), /invalid columns/i);
});

test("propagates statement failures so the route can roll back the transaction", async () => {
  const mock = mockClient({ failOn: "INSERT INTO" });
  await assert.rejects(executeDeveloperTransaction(mock.client as never, schema, [{ type: "insert", table: "customers", values: { name: "Ada" } }]), /simulated statement failure/);
});
