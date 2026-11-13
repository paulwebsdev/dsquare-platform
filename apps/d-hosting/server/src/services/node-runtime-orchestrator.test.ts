import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { startNodeRuntime } from "./node-runtime-orchestrator.js";
import type { RuntimeProvider } from "./runtime-provider.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const storageKey = "123e4567-e89b-42d3-a456-426614174002";
const key = Buffer.alloc(32, 9).toString("base64");
const processEnvironment = { HOSTING_SECRETS_KEY: key };
const hostingUserId = "11111111-1111-4111-8111-111111111111";
const databaseResourceId = "33333333-3333-4333-8333-333333333333";
const databasePassword = "database-runtime-password";
function approvedDatabaseConnection() {
  const encrypted = encryptEnvironmentSecret(databasePassword, processEnvironment, `d-database:${hostingUserId}:${databaseResourceId}`);
  return {
    user_id: hostingUserId,
    project_id: "22222222-2222-4222-8222-222222222222",
    resource_id: databaseResourceId,
    resource_name: "Customer Data",
    schema_name: "db_09800acba6c642d093f09d8aa73c2515",
    database_host: "database.internal",
    database_port: 5432,
    database_name: "d_database",
    database_role: "dsq_app_33333333333343338333333333333333",
    database_connection_limit: 5,
    database_password_ciphertext: encrypted.ciphertext,
    database_password_iv: encrypted.iv,
    database_password_auth_tag: encrypted.authTag,
  };
}
const validation = {
  valid: true as const,
  entrypoint: "server.js",
  startCommand: "npm start" as const,
  nodeMajor: 22 as const,
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-node-orchestrator-"));
  await mkdir(path.join(root, resourceId), { recursive: true });
  await writeFile(path.join(root, resourceId, storageKey), "console.log('isolated');");
  return root;
}

function input(storageRoot: string) {
  const secret = encryptEnvironmentSecret("private-value", processEnvironment, `${resourceId}:APP_SECRET`);
  return {
    resourceId, deploymentId, storageRoot,
    files: [{ originalName: "server.js", storageKey }],
    validation,
    encryptedVariables: [{ name: "APP_SECRET", ...secret }],
    processEnvironment,
  };
}

test("hands a prepared website to the isolated provider and clears secret references", async () => {
  const root = await fixture();
  let capturedSpec: Parameters<RuntimeProvider["start"]>[0] | undefined;
  const provider = {
    async start(spec: Parameters<RuntimeProvider["start"]>[0]) {
      capturedSpec = spec;
      assert.equal(spec.environment.APP_SECRET, "private-value");
      assert.equal(spec.environment.D_DATABASE_PASSWORD, databasePassword);
      return { containerId: "provider-instance-1" };
    },
  } as RuntimeProvider;

  try {
    const result = await startNodeRuntime({ ...input(root), hostingUserId, databaseConnection: approvedDatabaseConnection() }, provider);
    assert.equal(result.containerId, "provider-instance-1");
    assert.equal(result.fileCount, 1);
    assert.equal(capturedSpec?.environment.APP_SECRET, undefined);
    assert.equal(capturedSpec?.environment.D_DATABASE_PASSWORD, undefined);
    assert.equal(await readFile(path.join(result.artifactDirectory, "server.js"), "utf8"), "console.log('isolated');");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed without a provider and does not prepare customer files", async () => {
  const root = await fixture();
  try {
    await assert.rejects(startNodeRuntime(input(root), null), /execution remains disabled/);
    await assert.rejects(readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId, "server.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes prepared artifacts when the provider rejects startup", async () => {
  const root = await fixture();
  const provider = {
    async start() { throw new Error("provider failure"); },
    async stop() {},
  } as unknown as RuntimeProvider;
  try {
    await assert.rejects(startNodeRuntime(input(root), provider), /provider failure/);
    await assert.rejects(readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId, "server.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a provider response without a valid instance identifier", async () => {
  const root = await fixture();
  const provider = {
    async start() { return { containerId: " " }; },
  } as unknown as RuntimeProvider;
  try {
    await assert.rejects(startNodeRuntime(input(root), provider), /invalid instance identifier/);
    await assert.rejects(readFile(path.join(root, resourceId, "runtime-artifacts", deploymentId, "server.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
