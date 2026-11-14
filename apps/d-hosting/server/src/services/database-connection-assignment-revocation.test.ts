import assert from "node:assert/strict";
import test from "node:test";
import { revokeDatabaseConnectionAssignments } from "./database-connection-assignment-revocation.js";

const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hostingUserId = "11111111-1111-4111-8111-111111111111";

function clientFor(input: { rowCount?: number; failOn?: string } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let released = 0;
  return {
    calls,
    get released() { return released; },
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (input.failOn && sql.includes(input.failOn)) throw new Error("database transaction failed");
      if (sql.startsWith("UPDATE database_connections")) {
        return {
          rows: input.rowCount === 0 ? [] : [{ id: connectionId, status: "revoked", revoked_at: "2026-11-13T00:00:00.000Z" }],
          rowCount: input.rowCount ?? 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { released++; },
  };
}

test("removes website assignments and revokes the connection in one transaction", async () => {
  const client = clientFor();
  const result = await revokeDatabaseConnectionAssignments({ client, connectionId, hostingUserId });
  assert.equal(result?.status, "revoked");
  assert.deepEqual(client.calls.map(call => call.sql), [
    "BEGIN",
    "DELETE FROM hosting_resource_database_connections\n       WHERE database_connection_id = $1 AND hosting_user_id = $2",
    "UPDATE database_connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())\n       WHERE id = $1 AND hosting_user_id = $2 AND status = 'active'\n       RETURNING id, status, revoked_at",
    "COMMIT",
  ]);
  assert.equal(client.released, 1);
  assert.deepEqual(client.calls[1]?.values, [connectionId, hostingUserId]);
});

test("rolls back assignment deletion when the connection is no longer active", async () => {
  const client = clientFor({ rowCount: 0 });
  const result = await revokeDatabaseConnectionAssignments({ client, connectionId, hostingUserId });
  assert.equal(result, null);
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(client.calls.some(call => call.sql === "COMMIT"), false);
  assert.equal(client.released, 1);
});

test("rolls back and releases the client when revocation persistence fails", async () => {
  const client = clientFor({ failOn: "UPDATE database_connections" });
  await assert.rejects(
    revokeDatabaseConnectionAssignments({ client, connectionId, hostingUserId }),
    /transaction failed/,
  );
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(client.released, 1);
});
