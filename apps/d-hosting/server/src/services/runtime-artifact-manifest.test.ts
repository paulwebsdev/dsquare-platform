import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRuntimeArtifactManifest } from "./runtime-artifact-manifest.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-manifest-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"scripts":{"start":"node server.js"}}');
  await writeFile(path.join(root, "server.js"), "console.log('hello');");
  await writeFile(path.join(root, "src", "app.js"), "export default 1;");
  return root;
}

test("builds a deterministic manifest with sorted paths and content hashes", async () => {
  const root = await fixture();
  try {
    const first = await buildRuntimeArtifactManifest(root);
    const second = await buildRuntimeArtifactManifest(root);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.fileCount, 3);
    assert.equal(first.totalBytes, Buffer.byteLength('{"scripts":{"start":"node server.js"}}') + Buffer.byteLength("console.log('hello');") + Buffer.byteLength("export default 1;"));
    assert.deepEqual(first.files.map((file) => file.path), ["package.json", "server.js", "src/app.js"]);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.ok(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changes the manifest digest when file contents change", async () => {
  const root = await fixture();
  try {
    const before = await buildRuntimeArtifactManifest(root);
    await writeFile(path.join(root, "server.js"), "console.log('changed');");
    const after = await buildRuntimeArtifactManifest(root);
    assert.notEqual(before.sha256, after.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links and unsafe or unsupported artifact files", async () => {
  const root = await fixture();
  const outside = path.join(os.tmpdir(), "dsquare-runtime-outside.txt");
  try {
    await writeFile(outside, "outside");
    await symlink(outside, path.join(root, "linked.txt"));
    await assert.rejects(buildRuntimeArtifactManifest(root), /symbolic links/);
    await rm(path.join(root, "linked.txt"), { force: true });
    await writeFile(path.join(root, "unsafe.exe"), "not allowed");
    await assert.rejects(buildRuntimeArtifactManifest(root), /unsafe file path/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("rejects empty artifact directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-empty-"));
  try {
    await assert.rejects(buildRuntimeArtifactManifest(root), /at least one file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
