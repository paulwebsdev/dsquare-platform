import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { test } from "node:test";
import { signRuntimeAgentRequest } from "../../../d-hosting/server/src/services/runtime-agent-auth.js";
import { createRuntimeAgentApp } from "./index.js";

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