import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeArtifactBundle, deleteStoredArtifact, readStoredArtifact, storeRuntimeArtifact } from "./artifact-store.js";

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


test("packages a built workspace into a verified DSQART01 runtime artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-build-output-"));
  const workspace = path.join(root, "workspace");
  const storage = path.join(root, "storage");
  try {
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"scripts":{"start":"node server.js"}}');
    await writeFile(path.join(workspace, "server.js"), "console.log('ready')");
    await writeFile(path.join(workspace, "dist", "index.html"), "<h1>built</h1>");
    const bundle = await createRuntimeArtifactBundle(artifactId, workspace);
    assert.equal(bundle.fileCount, 3);
    assert.equal(bundle.sha256, createHash("sha256").update(bundle.bytes).digest("hex"));
    const stored = await storeRuntimeArtifact(storage, artifactId, bundle.bytes);
    assert.equal(stored.sha256, bundle.sha256);
    assert.equal(stored.fileCount, 3);
    assert.equal(await readFile(path.join(storage, artifactId, "dist", "index.html"), "utf8"), "<h1>built</h1>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses symlinks in build output packaging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-build-output-link-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    await writeFile(path.join(root, "outside.txt"), "outside");
    await symlink(path.join(root, "outside.txt"), path.join(workspace, "linked.txt"));
    await assert.rejects(() => createRuntimeArtifactBundle(artifactId, workspace), /symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
