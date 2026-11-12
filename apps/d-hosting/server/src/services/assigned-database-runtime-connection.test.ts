import assert from "node:assert/strict";
import test from "node:test";
import { getAssignedDatabaseRuntimeConnection } from "./assigned-database-runtime-connection.js";

const hostingUserId = "11111111-1111-4111-8111-111111111111";
const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const row = {
  user_id: hostingUserId,
  project_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "33333333-3333-4333-8333-333333333333",
  resource_name: "Customer Data",
  schema_name: "db_09800acba6c642d093f09d8aa73c2515",
  database_host: "database.internal",
  database_port: 5432,
  database_name: "d_database",
  database_role: "dsq_app_33333333333343338333333333333333",
  database_password_ciphertext: "encrypted-password",
  database_password_iv: "encrypted-iv",
  database_password_auth_tag: "encrypted-auth-tag",
};

function fakeQuery(rows: typeof row[] = [row]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  };
}

test("loads only the active connection assigned to the requested website and owner", async () => {
  const queryable = fakeQuery();
  const result = await getAssignedDatabaseRuntimeConnection({
    hostingUserId,
    resourceId,
    queryable,
  });
  assert.deepEqual(result, row);
  assert.deepEqual(queryable.calls[0].values, [resourceId, hostingUserId]);
  assert.match(queryable.calls[0].sql, /c\.status = 'active'/);
  assert.match(queryable.calls[0].sql, /assignment\.hosting_user_id = \$2/);
  assert.match(queryable.calls[0].sql, /c\.hosting_user_id = \$2/);
});

test("returns null when no active database is assigned", async () => {
  const result = await getAssignedDatabaseRuntimeConnection({
    hostingUserId,
    resourceId,
    queryable: fakeQuery([]),
  });
  assert.equal(result, null);
});

test("rejects incomplete encrypted credentials instead of launching without them", async () => {
  const incomplete = { ...row, database_password_auth_tag: "" };
  await assert.rejects(
    getAssignedDatabaseRuntimeConnection({
      hostingUserId,
      resourceId,
      queryable: fakeQuery([incomplete]),
    }),
    /missing required runtime credentials/,
  );
});
