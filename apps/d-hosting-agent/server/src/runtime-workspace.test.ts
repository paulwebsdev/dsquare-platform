import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function assertReadOnlyMode(actual: number, expected: number): void {
  assert.equal(actual & 0o222, 0, "workspace entries must not be writable");
  if (process.platform !== "win32") assert.equal(actual & 0o777, expected);
}
import { removeRuntimeWorkspace, materializeRuntimeWorkspace } from "./runtime-workspace.js";
import { storeRuntimeArtifact } from "./artifact-store.js";
import { createHash } from "node:crypto";

const artifactId = "7f7f7f7f-1111-4111-8111-111111111111";

test("materializes nested website files into a read-only workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-workspace-"));
  const storage = path.join(root, "stored");
  const runtime = path.join(root, "runtime");
  const artifact = path.join(storage, artifactId);
  try {
    const packageBytes = Buffer.from('{"scripts":{"start":"node index.js"}}');
    const logoBytes = Buffer.from("<svg/>");
    const files = [
      { path: "package.json", sizeBytes: packageBytes.byteLength, sha256: createHash("sha256").update(packageBytes).digest("hex") },
      { path: "public/assets/logo.svg", sizeBytes: logoBytes.byteLength, sha256: createHash("sha256").update(logoBytes).digest("hex") },
    ];
    const manifest = {
      sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      fileCount: files.length,
      totalBytes: packageBytes.byteLength + logoBytes.byteLength,
      files,
    };
    const manifestBytes = Buffer.from(JSON.stringify({ version: 1, artifactId, manifest }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestBytes.byteLength, 0);
    await mkdir(path.join(artifact, "public", "assets"), { recursive: true });
    await writeFile(path.join(artifact, "package.json"), packageBytes);
    await writeFile(path.join(artifact, "public", "assets", "logo.svg"), logoBytes);
    // Store through the validated artifact path so the integrity manifest is present.
    await rm(storage, { recursive: true, force: true });
    await storeRuntimeArtifact(storage, artifactId, Buffer.concat([Buffer.from("DSQART01"), header, manifestBytes, packageBytes, logoBytes]));
    const workspace = await materializeRuntimeWorkspace(storage, artifactId, runtime);
    assert.equal(await readFile(path.join(workspace, "package.json"), "utf8"), '{"scripts":{"start":"node index.js"}}');
    assert.equal(await readFile(path.join(workspace, "public", "assets", "logo.svg"), "utf8"), "<svg/>");
    assertReadOnlyMode((await lstat(workspace)).mode, 0o555);
    assertReadOnlyMode((await lstat(path.join(workspace, "package.json"))).mode, 0o444);
    assertReadOnlyMode((await lstat(path.join(workspace, "public"))).mode, 0o555);
    assert.equal(await removeRuntimeWorkspace(runtime, artifactId), true);
    assert.equal(await removeRuntimeWorkspace(runtime, artifactId), false);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links and leaves no partial workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-workspace-link-"));
  const storage = path.join(root, "stored");
  const runtime = path.join(root, "runtime");
  const artifact = path.join(storage, artifactId);
  try {
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "index.js"), "console.log('safe')");
    await writeFile(path.join(artifact, "oversized.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(materializeRuntimeWorkspace(storage, artifactId, runtime), /unsupported or oversized/);
    await assert.rejects(lstat(path.join(runtime, artifactId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stored file tampering and unexpected files before materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-runtime-workspace-integrity-"));
  const storage = path.join(root, "stored");
  const runtime = path.join(root, "runtime");
  const artifact = path.join(storage, artifactId);
  try {
    const bytes = Buffer.from("trusted");
    const file = { path: "index.js", sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    const manifest = { sha256: createHash("sha256").update(JSON.stringify([file])).digest("hex"), fileCount: 1, totalBytes: bytes.byteLength, files: [file] };
    const manifestBytes = Buffer.from(JSON.stringify({ version: 1, artifactId, manifest }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestBytes.byteLength, 0);
    await storeRuntimeArtifact(storage, artifactId, Buffer.concat([Buffer.from("DSQART01"), header, manifestBytes, bytes]));
    await writeFile(path.join(artifact, "index.js"), "tampered");
    await assert.rejects(materializeRuntimeWorkspace(storage, artifactId, runtime), /integrity check/);
    await writeFile(path.join(artifact, "index.js"), bytes);
    await writeFile(path.join(artifact, "unexpected.txt"), "not in manifest");
    await assert.rejects(materializeRuntimeWorkspace(storage, artifactId, runtime), /integrity check/);
    await assert.rejects(lstat(path.join(runtime, artifactId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
