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


test("stores multiple deployment runtimes for one website without overwriting the live version", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO runtime_agent_deployments")) {
        const deploymentId = String(values[1]);
        if (rows.has(deploymentId)) return { rowCount: 0, rows: [] };
        rows.set(deploymentId, {
          resource_id: values[0], deployment_id: deploymentId, artifact_id: values[2],
          container_id: null, state: "creating",
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE runtime_agent_deployments") && sql.includes("SET container_id")) {
        const row = rows.get(String(values[0]));
        if (!row || row.state !== "creating" || row.container_id !== null) return { rowCount: 0, rows: [] };
        row.container_id = values[1];
        row.state = "running";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT resource_id") && sql.includes("runtime_agent_deployments WHERE deployment_id")) {
        const row = rows.get(String(values[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes("SELECT resource_id") && sql.includes("runtime_agent_deployments ORDER BY")) {
        return { rowCount: rows.size, rows: [...rows.values()] };
      }
      if (sql.includes("UPDATE runtime_agent_deployments")) {
        const row = rows.get(String(values[0]));
        if (row) row.state = values[1];
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (sql.includes("DELETE FROM runtime_agent_deployments")) {
        rows.delete(String(values[0]));
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  const registry = new RuntimeRegistry(pool);
  const first = { ...record, containerId: null, state: "creating" as const };
  const second = {
    ...first,
    deploymentId: "33333333-3333-4333-8333-333333333333",
    artifactId: "33333333-3333-4333-8333-333333333333",
  };

  assert.equal(await registry.reserveDeployment(first), true);
  assert.equal(await registry.reserveDeployment(second), true);
  assert.equal(await registry.reserveDeployment(first), false);
  assert.equal(await registry.completeDeployment(first.deploymentId, "a".repeat(64)), true);
  assert.equal(await registry.completeDeployment(second.deploymentId, "b".repeat(64)), true);
  assert.equal((await registry.getDeployment(first.deploymentId))?.containerId, "a".repeat(64));
  assert.equal((await registry.getDeployment(second.deploymentId))?.containerId, "b".repeat(64));
  assert.equal((await registry.listDeployments()).length, 2);
  await registry.setDeploymentState(second.deploymentId, "stopped");
  assert.equal((await registry.getDeployment(first.deploymentId))?.state, "running");
  assert.equal((await registry.getDeployment(second.deploymentId))?.state, "stopped");
  await registry.deleteDeployment(second.deploymentId);
  assert.equal(await registry.getDeployment(second.deploymentId), null);
  assert.notEqual(await registry.getDeployment(first.deploymentId), null);
});
