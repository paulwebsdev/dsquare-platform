import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PodmanRuntimeProvider } from "./podman-runtime-provider.js";
import type { RuntimeRecord } from "./runtime-registry.js";
import { storeRuntimeArtifact } from "./artifact-store.js";
import type { PodmanRequest, PodmanResponse } from "./podman-client.js";

const resourceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const containerId = "a".repeat(64);

function runtimeRequest() {
  return {
    resourceId,
    deploymentId: artifactId,
    artifactId,
    runtime: {
      name: `dsquare-deploy-${artifactId}`,
      image: "node:22-bookworm-slim",
      workingDirectory: "/app" as const,
      command: ["npm", "start"] as ["npm", "start"],
      environment: { PORT: "3000", NODE_ENV: "production" },
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pidsLimit: 128,
      user: "10001:10001" as const,
      readOnlyRootFilesystem: true as const,
      capDrop: ["ALL"] as ["ALL"],
      securityOpt: ["no-new-privileges:true"] as ["no-new-privileges:true"],
      tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" as const },
    },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-podman-provider-"));
  const storageRoot = path.join(root, "stored");
  const runtimeRoot = path.join(root, "runtime");
  const packageBytes = Buffer.from('{"scripts":{"start":"node index.js"}}');
  const file = { path: "package.json", sizeBytes: packageBytes.byteLength, sha256: createHash("sha256").update(packageBytes).digest("hex") };
  const manifest = {
    sha256: createHash("sha256").update(JSON.stringify([file])).digest("hex"),
    fileCount: 1,
    totalBytes: packageBytes.byteLength,
    files: [file],
  };
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, artifactId, manifest }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.byteLength, 0);
  await storeRuntimeArtifact(storageRoot, artifactId, Buffer.concat([Buffer.from("DSQART01"), header, manifestBytes, packageBytes]));
  const calls: PodmanRequest[] = [];
  const transport = async (request: PodmanRequest): Promise<PodmanResponse> => {
    calls.push(request);
    if (request.path.startsWith("/v1.40/containers/create")) {
      return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: containerId })) };
    }
    if (request.method === "POST" && request.path.endsWith("/exec")) {
      return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: "e".repeat(64) })) };
    }
    if (request.path.includes("/exec/") && request.path.endsWith("/json")) {
      return { statusCode: 200, headers: {}, body: Buffer.from('{"Running":false,"ExitCode":0}') };
    }
    if (request.path.endsWith("/json")) {
      return { statusCode: 200, headers: {}, body: Buffer.from('{"State":{"Status":"running"}}') };
    }
    if (request.path.includes("/logs?")) {
      return { statusCode: 200, headers: {}, body: Buffer.from("runtime logs") };
    }
    return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
  };
  const provider = new PodmanRuntimeProvider({
    transport,
    storageRoot,
    runtimeRoot,
    trustedImage: "node:22-bookworm-slim",
    networkName: "dsquare-private",
    containerWorkspacePath: (_workspace, id) => `/var/lib/dsquare/runtime-workspaces/${id}`,
  });
  return { root, storageRoot, runtimeRoot, calls, transport, provider };
}

test("creates and starts an isolated container, then manages its lifecycle", async () => {
  const fixture = await setup();
  try {
    const created = await fixture.provider.createAndStart(runtimeRequest());
    assert.equal(created.containerId, containerId);
    assert.equal(await readFile(path.join(created.workspacePath, "package.json"), "utf8"),
      '{"scripts":{"start":"node index.js"}}');
    const createCall = fixture.calls.find((call) => call.path.startsWith("/v1.40/containers/create"));
    assert.ok(createCall);
    const config = createCall.body as { HostConfig: { Binds: string[]; PortBindings?: unknown } };
    assert.deepEqual(config.HostConfig.Binds, [
      `/var/lib/dsquare/runtime-workspaces/${artifactId}:/app:ro`,
    ]);
    assert.equal(config.HostConfig.PortBindings, undefined);
    const probeCall = fixture.calls.find((call) => call.method === "POST" && call.path.endsWith("/exec"));
    assert.ok(probeCall, "runtime must be probed from inside its private container");
    assert.deepEqual((probeCall.body as { Cmd: string[] }).Cmd.slice(0, 2), ["node", "-e"]);

    await fixture.provider.stop(containerId);
    await fixture.provider.restart(containerId);
    assert.deepEqual(await fixture.provider.inspect(containerId), { State: { Status: "running" } });
    const restartIndex = fixture.calls.findIndex((call) => call.path.endsWith("/restart?t=10"));
    const postRestartProbeIndex = fixture.calls.findIndex((call, index) => index > restartIndex && call.method === "POST" && call.path.endsWith("/exec"));
    assert.ok(postRestartProbeIndex > restartIndex, "restart must be followed by a private readiness probe");
    assert.equal((await fixture.provider.logs(containerId)).toString(), "runtime logs");
    assert.equal(await fixture.provider.remove(containerId, artifactId), true);
    await assert.rejects(lstat(path.join(fixture.runtimeRoot, artifactId)));
    assert.ok(fixture.calls.some((call) => call.path.endsWith("/stop?t=10")));
    assert.ok(fixture.calls.some((call) => call.path.endsWith("/restart?t=10")));
    assert.ok(fixture.calls.some((call) => call.method === "DELETE"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rolls back the container and workspace when start fails", async () => {
  const fixture = await setup();
  const rollbackCalls: string[] = [];
  const failingProvider = new PodmanRuntimeProvider({
    transport: async (request) => {
      rollbackCalls.push(`${request.method} ${request.path}`);
      if (request.path.startsWith("/v1.40/containers/create")) {
        return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: containerId })) };
      }
      if (request.path.endsWith("/start")) {
        return { statusCode: 500, headers: {}, body: Buffer.from('{"message":"start failed"}') };
      }
      return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    },
    storageRoot: path.join(fixture.root, "stored"),
    runtimeRoot: fixture.runtimeRoot,
    trustedImage: "node:22-bookworm-slim",
    networkName: "dsquare-private",
    containerWorkspacePath: (_workspace, id) => `/var/lib/dsquare/runtime-workspaces/${id}`,
  });
  try {
    await assert.rejects(failingProvider.createAndStart(runtimeRequest()), /start failed/);
    assert.ok(rollbackCalls.some((call) => call.startsWith("DELETE ")));
    await assert.rejects(lstat(path.join(fixture.runtimeRoot, artifactId)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports incomplete rollback when Podman refuses container removal", async () => {
  const fixture = await setup();
  const failingProvider = new PodmanRuntimeProvider({
    transport: async (request) => {
      if (request.path.startsWith("/v1.40/containers/create")) {
        return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: containerId })) };
      }
      if (request.path.endsWith("/start")) {
        return { statusCode: 500, headers: {}, body: Buffer.from('{"message":"start failed"}') };
      }
      if (request.method === "DELETE") {
        return { statusCode: 500, headers: {}, body: Buffer.from('{"message":"remove failed"}') };
      }
      return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    },
    storageRoot: fixture.storageRoot,
    runtimeRoot: fixture.runtimeRoot,
    trustedImage: "node:22-bookworm-slim",
    networkName: "dsquare-private",
    containerWorkspacePath: (_workspace, id) => `/var/lib/dsquare/runtime-workspaces/${id}`,
  });
  try {
    await assert.rejects(
      failingProvider.createAndStart(runtimeRequest()),
      (error: unknown) => error instanceof AggregateError &&
        error.message.includes("rollback was incomplete") &&
        error.errors.length === 2,
    );
    await assert.rejects(lstat(path.join(fixture.runtimeRoot, artifactId)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects malformed container identifiers before contacting Podman", async () => {
  const fixture = await setup();
  try {
    await assert.rejects(fixture.provider.stop("../../etc/passwd"), /identifier is invalid/);
    assert.equal(fixture.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("reconciles registered, pending, missing, and orphaned containers safely", async () => {
  const fixture = await setup();
  const pendingResourceId = "33333333-3333-4333-8333-333333333333";
  const missingResourceId = "44444444-4444-4444-8444-444444444444";
  const orphanResourceId = "55555555-5555-4555-8555-555555555555";
  const pendingDeploymentId = "66666666-6666-4666-8666-666666666666";
  const missingDeploymentId = "77777777-7777-4777-8777-777777777777";
  const orphanDeploymentId = "88888888-8888-4888-8888-888888888888";
  const existingContainerId = "a".repeat(64);
  const pendingContainerId = "b".repeat(64);
  const orphanContainerId = "c".repeat(64);
  const missingContainerId = "d".repeat(64);
  const rows = [
    { Id: existingContainerId, Labels: { "io.dsquare.managed": "true", "io.dsquare.resource-id": resourceId, "io.dsquare.deployment-id": artifactId, "io.dsquare.artifact-id": artifactId } },
    { Id: pendingContainerId, Labels: { "io.dsquare.managed": "true", "io.dsquare.resource-id": pendingResourceId, "io.dsquare.deployment-id": pendingDeploymentId, "io.dsquare.artifact-id": pendingDeploymentId } },
    { Id: orphanContainerId, Labels: { "io.dsquare.managed": "true", "io.dsquare.resource-id": orphanResourceId, "io.dsquare.deployment-id": orphanDeploymentId, "io.dsquare.artifact-id": orphanDeploymentId } },
  ];
  const records: RuntimeRecord[] = [
    { resourceId, deploymentId: artifactId, artifactId, containerId: existingContainerId, state: "running" },
    { resourceId: pendingResourceId, deploymentId: pendingDeploymentId, artifactId: pendingDeploymentId, containerId: null, state: "creating" },
    { resourceId: missingResourceId, deploymentId: missingDeploymentId, artifactId: missingDeploymentId, containerId: missingContainerId, state: "running" },
  ];
  const stateChanges: Array<{ resourceId: string; state: string }> = [];
  const registry = {
    getDeployment: async (id: string) => records.find((record) => record.deploymentId === id) ?? null,
    completeDeployment: async (id: string, idValue: string) => {
      const record = records.find((item) => item.deploymentId === id);
      if (!record || record.state !== "creating" || record.containerId !== null) return false;
      record.containerId = idValue;
      record.state = "running";
      return true;
    },
    listDeployments: async () => records,
    setDeploymentState: async (id: string, state: "unknown") => {
      const record = records.find((item) => item.deploymentId === id);
      stateChanges.push({ resourceId: record?.resourceId ?? id, state });
    },
  };
  const provider = new PodmanRuntimeProvider({
    transport: async (request) => {
      if (request.path.startsWith("/v1.40/containers/json")) {
        return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(rows)) };
      }
      return fixture.transport(request);
    },
    storageRoot: fixture.storageRoot,
    runtimeRoot: fixture.runtimeRoot,
    trustedImage: "node:22-bookworm-slim",
    networkName: "dsquare-private",
  });
  try {
    const result = await provider.reconcile(registry as never);
    assert.deepEqual(result, { adopted: 1, removed: 1 });
    assert.equal(records[1].containerId, pendingContainerId);
    assert.deepEqual(stateChanges, [{ resourceId: missingResourceId, state: "unknown" }]);
    const removed = fixture.calls;
    // Only the orphan is deleted; registered and adopted containers remain.
    const deletions = removed.filter((call) => call.method === "DELETE");
    assert.equal(deletions.length, 1);
    assert.ok(deletions[0].path.includes(orphanContainerId));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
