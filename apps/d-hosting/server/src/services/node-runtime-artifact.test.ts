import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareNodeRuntimeArtifact } from "./node-runtime-artifact.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const storageKey = "123e4567-e89b-42d3-a456-426614174002";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-node-artifact-"));
  await mkdir(path.join(root, resourceId), { recursive: true });
  await writeFile(path.join(root, resourceId, storageKey), "console.log('safe copy');");
  return root;
}

test("prepares a deployment-specific artifact preserving safe nested paths", async () => {
  const root = await fixture();
  try {
    const result = await prepareNodeRuntimeArtifact({
      resourceId, deploymentId, storageRoot: root,
      files: [{ originalName: "server.cjs", storageKey }],
    });
    assert.equal(result.fileCount, 1);
    assert.equal(await readFile(path.join(result.directory, "server.cjs"), "utf8"), "console.log('safe copy');");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe paths, duplicate names, and invalid storage keys", async () => {
  const root = await fixture();
  try {
    await assert.rejects(prepareNodeRuntimeArtifact({
      resourceId, deploymentId, storageRoot: root,
      files: [{ originalName: "../escape.js", storageKey }],
    }), /unsafe file path/);
    await assert.rejects(prepareNodeRuntimeArtifact({
      resourceId, deploymentId, storageRoot: root,
      files: [
        { originalName: "server.js", storageKey },
        { originalName: "server.js", storageKey },
      ],
    }), /duplicate file paths/);
    await assert.rejects(prepareNodeRuntimeArtifact({
      resourceId, deploymentId, storageRoot: root,
      files: [{ originalName: "server.js", storageKey: "not-a-uuid" }],
    }), /unsafe file path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a partially prepared artifact when a stored file is missing", async () => {
  const root = await fixture();
  try {
    await assert.rejects(prepareNodeRuntimeArtifact({
      resourceId, deploymentId, storageRoot: root,
      files: [
        { originalName: "server.js", storageKey },
        { originalName: "missing.js", storageKey: "123e4567-e89b-42d3-a456-426614174003" },
      ],
    }));
    await assert.rejects(
      readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId, "server.js")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
