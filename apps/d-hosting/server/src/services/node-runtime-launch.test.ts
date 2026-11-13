import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { getAssignedDatabaseRuntimeConnection } from "./assigned-database-runtime-connection.js";
import { getBackendRouteTarget } from "./backend-route-target.js";
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


test("adds only the selected approved database connection to the isolated runtime spec", async () => {
  const root = await fixture();
  const hostingUserId = "11111111-1111-4111-8111-111111111111";
  const databaseResourceId = "33333333-3333-4333-8333-333333333333";
  const databasePassword = "database-runtime-password";
  const { encryptEnvironmentSecret } = await import("./environment-secrets.js");
  const encrypted = encryptEnvironmentSecret(
    databasePassword,
    environment,
    `d-database:${hostingUserId}:${databaseResourceId}`,
  );
  try {
    const launch = await prepareNodeRuntimeLaunch({
      resourceId,
      deploymentId,
      storageRoot: root,
      files: [{ originalName: "server.js", storageKey }],
      validation,
      encryptedVariables: [],
      hostingUserId,
      databaseConnection: {
        user_id: hostingUserId,
        project_id: "22222222-2222-4222-8222-222222222222",
        resource_id: databaseResourceId,
        resource_name: "Customer Data",
        schema_name: "db_09800acba6c642d093f09d8aa73c2515",
        database_host: "database.internal",
        database_port: 5432,
        database_name: "d_database",
        database_role: "dsq_app_33333333333343338333333333333333",
        database_password_ciphertext: encrypted.ciphertext,
        database_password_iv: encrypted.iv,
        database_password_auth_tag: encrypted.authTag,
      },
      processEnvironment: environment,
    });
    assert.equal(launch.spec.environment.D_DATABASE_PASSWORD, databasePassword);
    assert.equal(launch.spec.environment.D_DATABASE_RESOURCE_ID, databaseResourceId);
    assert.equal(launch.spec.environment.PORT, "3000");
    assert.equal(launch.spec.environment.HOSTING_SECRETS_KEY, undefined);
    clearPreparedRuntimeEnvironment(launch);
    assert.equal(launch.spec.environment.D_DATABASE_PASSWORD, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("integrates owner-scoped database assignment, encrypted secret injection, and deployment ingress target", async () => {
  const root = await fixture();
  const hostingUserId = "11111111-1111-4111-8111-111111111111";
  const databaseResourceId = "33333333-3333-4333-8333-333333333333";
  const databasePassword = "scoped-database-secret";
  const encrypted = encryptEnvironmentSecret(
    databasePassword,
    environment,
    `d-database:${hostingUserId}:${databaseResourceId}`,
  );
  const assignedRow = {
    user_id: hostingUserId,
    project_id: "22222222-2222-4222-8222-222222222222",
    resource_id: databaseResourceId,
    resource_name: "Customer Data",
    schema_name: "db_09800acba6c642d093f09d8aa73c2515",
    database_host: "database.internal",
    database_port: 5432,
    database_name: "d_database",
    database_role: "dsq_app_33333333333343338333333333333333",
    database_password_ciphertext: encrypted.ciphertext,
    database_password_iv: encrypted.iv,
    database_password_auth_tag: encrypted.authTag,
  };
  const queryable = {
    async query(sql: string, values?: unknown[]) {
      assert.match(sql, /assignment\.hosting_user_id = \$2/);
      assert.match(sql, /c\.hosting_user_id = \$2/);
      assert.match(sql, /c\.status = 'active'/);
      assert.deepEqual(values, [resourceId, hostingUserId]);
      return { rows: [assignedRow], rowCount: 1 };
    },
  };

  try {
    const assigned = await getAssignedDatabaseRuntimeConnection({
      hostingUserId,
      resourceId,
      queryable,
    });
    assert.ok(assigned);

    const launch = await prepareNodeRuntimeLaunch({
      resourceId,
      deploymentId,
      storageRoot: root,
      files: [{ originalName: "server.js", storageKey }],
      validation,
      encryptedVariables: [],
      hostingUserId,
      databaseConnection: assigned!,
      processEnvironment: environment,
    });

    assert.equal(launch.spec.environment.D_DATABASE_PASSWORD, databasePassword);
    assert.equal(launch.spec.environment.D_DATABASE_RESOURCE_ID, databaseResourceId);
    assert.equal(
      getBackendRouteTarget(resourceId, deploymentId),
      `http://dsquare-deploy-${deploymentId}.runtime.dsquare.internal:3000`,
    );
    assert.equal(launch.spec.environment.HOSTING_SECRETS_KEY, undefined);
    clearPreparedRuntimeEnvironment(launch);
    assert.equal(launch.spec.environment.D_DATABASE_PASSWORD, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
