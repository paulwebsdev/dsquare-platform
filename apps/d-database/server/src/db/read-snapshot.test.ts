import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { withReadSnapshot } from "./read-snapshot.js";

function createMockPool(options?: { failOperation?: boolean }) {
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement === "operation" && options?.failOperation) {
        throw new Error("query failed");
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const databasePool = {
    connect: async () => client,
  } as unknown as Pick<Pool, "connect">;

  return { databasePool, statements, wasReleased: () => released, client };
}

test("runs read work in a repeatable-read, read-only transaction and commits", async () => {
  const mock = createMockPool();
  const result = await withReadSnapshot(mock.databasePool, async (client) => {
    await client.query("operation");
    return "consistent";
  });

  assert.equal(result, "consistent");
  assert.deepEqual(mock.statements, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "operation",
    "COMMIT",
  ]);
  assert.equal(mock.wasReleased(), true);
});

test("rolls back failed read work and always releases the client", async () => {
  const mock = createMockPool({ failOperation: true });

  await assert.rejects(
    withReadSnapshot(mock.databasePool, async (client) => {
      await client.query("operation");
    }),
    /query failed/,
  );

  assert.deepEqual(mock.statements, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "operation",
    "ROLLBACK",
  ]);
  assert.equal(mock.wasReleased(), true);
});
