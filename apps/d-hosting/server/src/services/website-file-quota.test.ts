import assert from "node:assert/strict";
import test from "node:test";
import { checkWebsiteFileQuota } from "./website-file-quota.js";

function fakeQueryable(quota: number, used: number) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM hosting_resources")) return { rows: [{ file_storage_quota_bytes: quota }], rowCount: 1 };
      return { rows: [{ used_bytes: used }], rowCount: 1 };
    },
  };
}

test("returns remaining website storage after a valid upload reservation check", async () => {
  const queryable = fakeQueryable(1000, 400);
  const result = await checkWebsiteFileQuota({ queryable, projectId: "project", resourceId: "site", uploadBytes: 200 });
  assert.deepEqual(result, { usedBytes: 400, quotaBytes: 1000, remainingBytes: 600 });
  assert.match(queryable.calls[0].sql, /FOR UPDATE/);
});

test("rejects an upload that would exceed the website quota", async () => {
  await assert.rejects(
    checkWebsiteFileQuota({ queryable: fakeQueryable(1000, 900), projectId: "project", resourceId: "site", uploadBytes: 101 }),
    (error: unknown) => (error as { code?: string }).code === "HOSTING_STORAGE_QUOTA_EXCEEDED",
  );
});

test("rejects invalid upload sizes and missing websites", async () => {
  await assert.rejects(
    checkWebsiteFileQuota({ queryable: fakeQueryable(1000, 0), projectId: "project", resourceId: "site", uploadBytes: 0 }),
    /positive safe integer/,
  );
  const missing = { query: async () => ({ rows: [], rowCount: 0 }) };
  await assert.rejects(
    checkWebsiteFileQuota({ queryable: missing, projectId: "project", resourceId: "site", uploadBytes: 1 }),
    /Website resource not found/,
  );
});
