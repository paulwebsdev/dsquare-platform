import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { test } from "node:test";
import { signRuntimeAgentRequest } from "../../../d-hosting/server/src/services/runtime-agent-auth.js";
import { createRuntimeAgentApp, isRuntimeCreateRequest } from "./index.js";

const SECRET = "runtime-agent-test-secret-with-at-least-32-bytes";

test("authenticates the full endpoint path and rejects a replayed nonce", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-test-"));
  const claimedNonces = new Set<string>();
  const fakePool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO runtime_agent_nonces")) {
        const nonce = String(values?.[0] ?? "");
        if (claimedNonces.has(nonce)) return { rowCount: 0, rows: [] };
        claimedNonces.add(nonce);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  const server = createServer(createRuntimeAgentApp({
    pool: fakePool,
    secret: SECRET,
    storageRoot: root,
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pathname = "/v1/runtimes";
    const body = Buffer.from("{", "utf8");
    const nonce = randomUUID();
    const headers = signRuntimeAgentRequest({
      method: "POST",
      pathname,
      body,
      secret: SECRET,
      nonce,
    });
    const send = () => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });

    const first = await send();
    assert.equal(first.status, 400);
    const replay = await send();
    assert.equal(replay.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects runtime requests that weaken the isolation contract", () => {
  const valid = {
    resourceId: "11111111-1111-4111-8111-111111111111",
    deploymentId: "22222222-2222-4222-8222-222222222222",
    artifact: {
      artifactId: "22222222-2222-4222-8222-222222222222",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      fileCount: 1,
    },
    runtime: {
      name: "dsquare-site-11111111-1111-4111-8111-111111111111",
      image: "node:22-bookworm-slim",
      workingDirectory: "/app",
      command: ["npm", "start"],
      environment: { PORT: "3000", NODE_ENV: "production" },
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pidsLimit: 128,
      user: "10001:10001",
      readOnlyRootFilesystem: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
    },
  };
  assert.equal(isRuntimeCreateRequest(valid), true);
  assert.equal(isRuntimeCreateRequest({
    ...valid,
    runtime: { ...valid.runtime, readOnlyRootFilesystem: false },
  }), false);
  assert.equal(isRuntimeCreateRequest({
    ...valid,
    runtime: { ...valid.runtime, capDrop: [] },
  }), false);
  assert.equal(isRuntimeCreateRequest({
    ...valid,
    runtime: { ...valid.runtime, environment: { PORT: "3001" } },
  }), false);
  assert.equal(isRuntimeCreateRequest({
    ...valid,
    runtime: { ...valid.runtime, command: ["sh", "-c", "malicious"] },
  }), false);
});
