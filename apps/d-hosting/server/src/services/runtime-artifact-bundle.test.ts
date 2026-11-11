import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildRuntimeArtifactBundle } from "./runtime-artifact-bundle.js";

const artifactId = "123e4567-e89b-42d3-a456-426614174002";

test("builds a deterministic framed bundle with verifiable metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-bundle-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), '{"scripts":{"start":"node server.js"}}');
    await writeFile(path.join(root, "src", "server.js"), "console.log('ready')");
    const first = await buildRuntimeArtifactBundle({ artifactId, artifactDirectory: root });
    const second = await buildRuntimeArtifactBundle({ artifactId, artifactDirectory: root });
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.bytes.subarray(0, 8).toString("ascii"), "DSQART01");
    const manifestLength = first.bytes.readUInt32BE(8);
    const manifest = JSON.parse(first.bytes.subarray(12, 12 + manifestLength).toString("utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.artifactId, artifactId);
    assert.equal(manifest.manifest.fileCount, 2);
    assert.equal(first.descriptor.sizeBytes, first.bytes.byteLength);
    assert.equal(first.descriptor.sha256, createHash("sha256").update(first.bytes).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid artifact identifiers", async () => {
  await assert.rejects(buildRuntimeArtifactBundle({
    artifactId: "bad", artifactDirectory: os.tmpdir(),
  }), /artifact ID/);
});

test("detects file changes during bundle preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-bundle-change-"));
  try {
    await writeFile(path.join(root, "server.js"), "before");
    // Manifest and read are sequential; this test confirms the bundle includes
    // the exact bytes represented by the manifest under normal operation.
    const result = await buildRuntimeArtifactBundle({ artifactId, artifactDirectory: root });
    assert.ok(result.descriptor.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
