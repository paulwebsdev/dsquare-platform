import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { test } from "node:test";
import { signRuntimeAgentRequest } from "../../../d-hosting/server/src/services/runtime-agent-auth.js";
import { createRuntimeAgentApp, isRuntimeCreateRequest, isTrustedRuntimeImage, resolveRuntimeAgentHost } from "./index.js";
import { storeRuntimeArtifact } from "./artifact-store.js";

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
      body: new Uint8Array(body),
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


test("binds to loopback by default and rejects invalid listen hosts", () => {
  assert.equal(resolveRuntimeAgentHost(undefined), "127.0.0.1");
  assert.equal(resolveRuntimeAgentHost("10.0.0.12"), "10.0.0.12");
  assert.equal(resolveRuntimeAgentHost("::1"), "::1");
  assert.throws(() => resolveRuntimeAgentHost("0.0.0.0:5003"));
  assert.throws(() => resolveRuntimeAgentHost("public.example.com"));
});

test("exposes minimal liveness and database readiness checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-health-"));
  const fakePool = {
    query: async () => ({ rowCount: 1, rows: [{ "?column?": 1 }] }),
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
    const base = `http://127.0.0.1:${address.port}`;
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});


test("requires the exact artifact and JSON content types", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-content-type-"));
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
  const server = createServer(createRuntimeAgentApp({ pool: fakePool, secret: SECRET, storageRoot: root }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const send = async (method: "PUT" | "POST", pathname: string, body: Buffer, contentType: string) => {
      const headers = signRuntimeAgentRequest({ method, pathname, body, secret: SECRET });
      return fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        method,
        headers: { ...headers, "content-type": contentType },
        body: new Uint8Array(body),
      });
    };
    const artifact = await send(
      "PUT",
      "/v1/artifacts/33333333-3333-4333-8333-333333333333",
      Buffer.from("not-a-bundle"),
      "application/octet-stream",
    );
    assert.equal(artifact.status, 415);
    const runtime = await send("POST", "/v1/runtimes", Buffer.from("{}"), "text/plain");
    assert.equal(runtime.status, 415);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("returns not-ready when the database health query fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-not-ready-"));
  const fakePool = {
    query: async () => { throw new Error("database unavailable"); },
  } as unknown as Pool;
  const server = createServer(createRuntimeAgentApp({ pool: fakePool, secret: SECRET, storageRoot: root }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});


test("provides authenticated runtime capability status without enabling execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-capabilities-"));
  const claimedNonces = new Set<string>();
  const fakePool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO runtime_agent_nonces")) {
        const nonce = String(values?.[0] ?? "");
        if (claimedNonces.has(nonce)) return { rowCount: 0, rows: [] };
        claimedNonces.add(nonce);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const server = createServer(createRuntimeAgentApp({ pool: fakePool, secret: SECRET, storageRoot: root }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pathname = "/v1/health";
    const headers = signRuntimeAgentRequest({ method: "GET", pathname, secret: SECRET });
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      providerConfigured: false,
      executionEnabled: false,
    });
    const unauthenticated = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("requires an explicitly configured trusted runtime image", () => {
  assert.equal(isTrustedRuntimeImage("node:22-bookworm-slim", "node:22-bookworm-slim"), true);
  assert.equal(isTrustedRuntimeImage("node:latest", "node:22-bookworm-slim"), false);
  assert.equal(isTrustedRuntimeImage("node:22-bookworm-slim", undefined), false);
  assert.equal(isTrustedRuntimeImage("node:22-bookworm-slim", "   "), false);
});


test("keeps customer execution disabled by default even when a provider is configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-disabled-default-"));
  const claimedNonces = new Set<string>();
  const fakePool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO runtime_agent_nonces")) {
        const nonce = String(values?.[0] ?? "");
        if (claimedNonces.has(nonce)) return { rowCount: 0, rows: [] };
        claimedNonces.add(nonce);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const provider = {
    createAndStart: async () => { throw new Error("must not execute"); },
    reconcile: async () => ({ adopted: 0, removed: 0 }),
    stop: async () => undefined,
    restart: async () => undefined,
    inspect: async () => ({}),
    logs: async () => Buffer.alloc(0),
    remove: async () => true,
  };
  const server = createServer(createRuntimeAgentApp({
    pool: fakePool,
    secret: SECRET,
    storageRoot: root,
    provider: provider as never,
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pathname = "/v1/health";
    const headers = signRuntimeAgentRequest({ method: "GET", pathname, secret: SECRET });
    const response = await fetch("http://127.0.0.1:" + address.port + pathname, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      providerConfigured: true,
      executionEnabled: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});


test("refuses runtime creation while execution is disabled, even with a trusted provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-execution-guard-"));
  const resourceId = "11111111-1111-4111-8111-111111111111";
  const deploymentId = "22222222-2222-4222-8222-222222222222";
  const fileBytes = Buffer.from("console.log('safe')");
  const file = { path: "index.js", sizeBytes: fileBytes.length, sha256: createHash("sha256").update(fileBytes).digest("hex") };
  const manifest = { sha256: createHash("sha256").update(JSON.stringify([file])).digest("hex"), fileCount: 1, totalBytes: fileBytes.length, files: [file] };
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, artifactId: deploymentId, manifest }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.length, 0);
  const bundle = Buffer.concat([Buffer.from("DSQART01"), header, manifestBytes, fileBytes]);
  const stored = await storeRuntimeArtifact(root, deploymentId, bundle);
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
  let createCalls = 0;
  const provider = {
    createAndStart: async () => { createCalls += 1; throw new Error("must not execute"); },
    reconcile: async () => ({ adopted: 0, removed: 0 }),
    stop: async () => undefined,
    restart: async () => undefined,
    inspect: async () => ({}),
    logs: async () => Buffer.alloc(0),
    remove: async () => true,
  };
  const server = createServer(createRuntimeAgentApp({
    pool: fakePool,
    secret: SECRET,
    storageRoot: root,
    provider: provider as never,
    trustedImage: "node:22-bookworm-slim",
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pathname = "/v1/runtimes";
    const payload = {
      resourceId,
      deploymentId,
      artifact: stored,
      runtime: {
        name: "dsquare-site-" + resourceId,
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
    const body = Buffer.from(JSON.stringify(payload));
    const headers = signRuntimeAgentRequest({ method: "POST", pathname, body, secret: SECRET });
    const response = await fetch("http://127.0.0.1:" + address.port + pathname, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: new Uint8Array(body),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /disabled pending Linux isolation acceptance/);
    assert.equal(createCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});


test("keeps the isolated builder endpoint disabled unless explicitly configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-builder-disabled-"));
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
  const server = createServer(createRuntimeAgentApp({ pool: fakePool, secret: SECRET, storageRoot: root }));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pathname = "/v1/builds";
    const body = Buffer.from(JSON.stringify({
      sourceArtifactId: "11111111-1111-4111-8111-111111111111",
      deploymentId: "22222222-2222-4222-8222-222222222222",
      cacheAttestation: {},
    }));
    const headers = signRuntimeAgentRequest({ method: "POST", pathname, body, secret: SECRET });
    const response = await fetch("http://127.0.0.1:" + address.port + pathname, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: new Uint8Array(body),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /builder is not enabled/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
  }
});
