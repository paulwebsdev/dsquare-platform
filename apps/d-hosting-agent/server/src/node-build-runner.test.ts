import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeBuildCacheAttestation, NODE_BUILDER_IMAGE } from "./node-build-cache.js";
import { storeRuntimeArtifact } from "./artifact-store.js";
import { PodmanNodeBuildRunner } from "./node-build-runner.js";
import type { PodmanRequest, PodmanResponse } from "./podman-client.js";

const sourceArtifactId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const signingKey = "node-build-runner-test-signing-key-32-bytes";
const packageJson = JSON.stringify({
  name: "demo-site",
  scripts: { start: "node server.js", build: "node build.js" },
  engines: { node: "22.x" },
});
const packageLockJson = JSON.stringify({
  name: "demo-site",
  lockfileVersion: 3,
  packages: { "": { name: "demo-site" } },
});
const attestation = createNodeBuildCacheAttestation({
  packageLockJson,
  builderImage: NODE_BUILDER_IMAGE,
  npmVersion: "10.9.4",
  verifiedCacheIntegrities: [],
  npmCacheVerified: true,
  verifiedAt: "2026-11-12T00:00:00.000Z",
  signingKey,
});

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

test("builds an immutable runtime artifact inside a networkless isolated Podman builder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-node-builder-"));
  const storageRoot = path.join(root, "artifacts");
  const cacheRoot = path.join(root, "caches");
  const workspaceRoot = path.join(root, "workspaces");
  const cacheDirectory = path.join(cacheRoot, attestation.lockfileSha256);
  await mkdir(cacheDirectory, { recursive: true });
  const sourceBundle = await import("./artifact-store.js").then(async (module) => {
    const sourceDirectory = path.join(root, "source");
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, "package.json"), packageJson);
    await writeFile(path.join(sourceDirectory, "package-lock.json"), packageLockJson);
    await writeFile(path.join(sourceDirectory, "server.js"), "console.log('server')");
    await writeFile(path.join(sourceDirectory, "build.js"), "console.log('build')");
    const bundle = await module.createRuntimeArtifactBundle(sourceArtifactId, sourceDirectory);
    await storeRuntimeArtifact(storageRoot, sourceArtifactId, bundle.bytes);
    return bundle;
  });
  assert.ok(sourceBundle.sizeBytes > 0);

  const calls: PodmanRequest[] = [];
  let execCount = 0;
  const transport = async (request: PodmanRequest): Promise<PodmanResponse> => {
    calls.push(request);
    if (request.path.includes("/containers/create")) {
      return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: "a".repeat(64) })) };
    }
    if (request.path.endsWith("/start") && request.method === "POST" && request.path.includes("/containers/")) {
      return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    }
    if (request.path.endsWith("/exec") && request.method === "POST") {
      execCount += 1;
      return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: String(execCount).repeat(64).slice(0,64) })) };
    }
    if (request.path.endsWith("/start") && request.method === "POST" && request.path.includes("/exec/")) {
      return { statusCode: 200, headers: {}, body: frame("phase completed") };
    }
    if (request.path.endsWith("/json") && request.method === "GET") {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ Running: false, ExitCode: 0 })) };
    }
    if (request.method === "DELETE") return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    throw new Error("Unexpected Podman request: " + request.method + " " + request.path);
  };

  try {
    const runner = new PodmanNodeBuildRunner({
      transport, storageRoot, workspaceRoot, cacheRoot, signingKey,
      containerPath: (hostPath) => hostPath,
    });
    const result = await runner.build({ sourceArtifactId, deploymentId, cacheAttestation: attestation });
    assert.equal(result.artifactId, deploymentId);
    assert.equal(result.fileCount, 4);
    assert.match(result.output, /install/);
    assert.match(result.output, /build/);
    const create = calls.find((call) => call.path.includes("/containers/create"));
    const config = create?.body as { HostConfig: Record<string, unknown>; Image: string };
    assert.equal(config.Image, NODE_BUILDER_IMAGE);
    assert.equal(config.HostConfig.NetworkMode, "none");
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(config.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(config.HostConfig.Binds, [
      path.join(storageRoot, sourceArtifactId) + ":/input:ro",
      path.join(workspaceRoot, deploymentId) + ":/workspace:rw",
      cacheDirectory + ":/npm-cache:ro",
    ]);
    assert.equal(calls.filter((call) => call.path.endsWith("/exec")).length, 2);
    assert.ok(calls.some((call) => call.method === "DELETE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a build without the exact lockfile's signed cache attestation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-node-builder-reject-"));
  try {
    const runner = new PodmanNodeBuildRunner({
      transport: async () => { throw new Error("Podman must not be called."); },
      storageRoot: path.join(root, "artifacts"),
      workspaceRoot: path.join(root, "workspaces"),
      cacheRoot: path.join(root, "caches"),
      signingKey,
      containerPath: (hostPath) => hostPath,
    });
    await assert.rejects(() => runner.build({
      sourceArtifactId, deploymentId,
      cacheAttestation: { ...attestation, signature: "0".repeat(64) },
    }), /signature is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
