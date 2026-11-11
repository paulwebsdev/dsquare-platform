import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import {
  clearPreparedRuntimeEnvironment,
  prepareNodeRuntimeLaunch,
} from "./node-runtime-launch.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const storageKey = "123e4567-e89b-42d3-a456-426614174002";
const key = Buffer.alloc(32, 7).toString("base64");
const environment = { HOSTING_SECRETS_KEY: key };
const validation = {
  valid: true as const,
  entrypoint: "server.js",
  startCommand: "npm start" as const,
  nodeMajor: 22 as const,
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-node-launch-"));
  await mkdir(path.join(root, resourceId), { recursive: true });
  await writeFile(path.join(root, resourceId, storageKey), "console.log('launch');");
  return root;
}

test("prepares a read-only launch spec with only this website's decrypted variables", async () => {
  const root = await fixture();
  try {
    const secret = encryptEnvironmentSecret("website-secret", environment, `${resourceId}:APP_SECRET`);
    const launch = await prepareNodeRuntimeLaunch({
      resourceId,
      deploymentId,
      storageRoot: root,
      files: [{ originalName: "server.js", storageKey }],
      validation,
      encryptedVariables: [{ name: "APP_SECRET", ...secret }],
      processEnvironment: environment,
    });

    assert.equal(launch.fileCount, 1);
    assert.equal(await readFile(path.join(launch.artifactDirectory, "server.js"), "utf8"), "console.log('launch');");
    assert.equal(launch.spec.environment.APP_SECRET, "website-secret");
    assert.equal(launch.spec.environment.HOSTING_SECRETS_KEY, undefined);
    assert.equal(launch.spec.environment.PORT, "3000");
    assert.deepEqual(launch.spec.mounts, [{
      source: launch.artifactDirectory,
      target: "/app",
      readOnly: true,
    }]);

    clearPreparedRuntimeEnvironment(launch);
    assert.equal(launch.spec.environment.APP_SECRET, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans the prepared artifact if resource-bound secret decryption fails", async () => {
  const root = await fixture();
  try {
    const secret = encryptEnvironmentSecret("other-resource-secret", environment, "123e4567-e89b-42d3-a456-426614174099:APP_SECRET");
    await assert.rejects(prepareNodeRuntimeLaunch({
      resourceId,
      deploymentId,
      storageRoot: root,
      files: [{ originalName: "server.js", storageKey }],
      validation,
      encryptedVariables: [{ name: "APP_SECRET", ...secret }],
      processEnvironment: environment,
    }));
    await assert.rejects(readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId, "server.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not prepare artifacts for an invalid Node project", async () => {
  const root = await fixture();
  try {
    await assert.rejects(prepareNodeRuntimeLaunch({
      resourceId,
      deploymentId,
      storageRoot: root,
      files: [{ originalName: "server.js", storageKey }],
      validation: { valid: false, error: "invalid project" },
      encryptedVariables: [],
      processEnvironment: environment,
    }), /valid Node.js project/);
    await assert.rejects(readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
