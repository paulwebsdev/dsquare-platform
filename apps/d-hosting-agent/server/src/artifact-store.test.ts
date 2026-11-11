import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteStoredArtifact, readStoredArtifact, storeRuntimeArtifact } from "./artifact-store.js";

const artifactId = "7f7f7f7f-1111-4111-8111-111111111111";

function buildBundle(filePath = "index.js", fileBytes = Buffer.from("console.log('safe')")): Buffer {
  const file = {
    path: filePath,
    sizeBytes: fileBytes.byteLength,
    sha256: createHash("sha256").update(fileBytes).digest("hex"),
  };
  const manifest = {
    sha256: createHash("sha256").update(JSON.stringify([file])).digest("hex"),
    fileCount: 1,
    totalBytes: fileBytes.byteLength,
    files: [file],
  };
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, artifactId, manifest }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.byteLength, 0);
  return Buffer.concat([Buffer.from("DSQART01"), header, manifestBytes, fileBytes]);
}

test("stores a validated artifact and returns its exact descriptor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-"));
  try {
    const bundle = buildBundle();
    const stored = await storeRuntimeArtifact(root, artifactId, bundle);
    assert.equal(stored.artifactId, artifactId);
    assert.equal(stored.sha256, createHash("sha256").update(bundle).digest("hex"));
    assert.equal(stored.sizeBytes, bundle.byteLength);
    assert.equal(stored.fileCount, 1);
    assert.equal(await readFile(path.join(root, artifactId, "index.js"), "utf8"), "console.log('safe')");
    assert.deepEqual(await readStoredArtifact(root, artifactId), stored);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal paths and altered file contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-"));
  try {
    await assert.rejects(storeRuntimeArtifact(root, artifactId, buildBundle("../outside.js")));
    const altered = buildBundle();
    altered[altered.length - 1] ^= 1;
    await assert.rejects(storeRuntimeArtifact(root, artifactId, altered));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deletes only an existing validated artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-agent-"));
  try {
    await storeRuntimeArtifact(root, artifactId, buildBundle());
    assert.equal(await deleteStoredArtifact(root, artifactId), true);
    assert.equal(await readStoredArtifact(root, artifactId), null);
    assert.equal(await deleteStoredArtifact(root, artifactId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
