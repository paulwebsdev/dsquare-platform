import assert from "node:assert/strict";
import type { Pool } from "pg";
import { test } from "node:test";
import { RuntimeRegistry } from "./runtime-registry.js";

const record = {
  resourceId: "11111111-1111-4111-8111-111111111111",
  deploymentId: "22222222-2222-4222-8222-222222222222",
  artifactId: "22222222-2222-4222-8222-222222222222",
  containerId: "a".repeat(64),
  state: "running" as const,
};

test("atomically reserves, completes, reads, and deletes runtime mappings", async () => {
  let saved: Record<string, unknown> | undefined;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO runtime_agent_runtimes")) {
        if (saved) return { rowCount: 0, rows: [] };
        saved = {
          resource_id: values[0],
          deployment_id: values[1],
          artifact_id: values[2],
          container_id: null,
          state: "creating",
        };
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE runtime_agent_runtimes") && sql.includes("SET container_id")) {
        if (!saved || saved.state !== "creating") return { rowCount: 0, rows: [] };
        saved.container_id = values[1];
        saved.state = "running";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT resource_id")) {
        return { rowCount: saved ? 1 : 0, rows: saved ? [saved] : [] };
      }
      if (sql.includes("UPDATE runtime_agent_runtimes")) {
        if (saved) saved.state = values[1];
        return { rowCount: saved ? 1 : 0, rows: [] };
      }
      if (sql.includes("DELETE FROM runtime_agent_runtimes")) {
        saved = undefined;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  const registry = new RuntimeRegistry(pool);

  assert.equal(await registry.reserve(record), true);
  assert.equal(await registry.reserve(record), false);
  const pending = await registry.get(record.resourceId);
  assert.equal(pending?.state, "creating");
  assert.equal(pending?.containerId, null);
  assert.equal(await registry.complete(record.resourceId, record.containerId), true);
  assert.equal(await registry.complete(record.resourceId, record.containerId), false);
  assert.deepEqual(await registry.get(record.resourceId), record);
  await registry.setState(record.resourceId, "stopped");
  assert.equal((await registry.get(record.resourceId))?.state, "stopped");
  await registry.delete(record.resourceId);
  assert.equal(await registry.get(record.resourceId), null);
});
