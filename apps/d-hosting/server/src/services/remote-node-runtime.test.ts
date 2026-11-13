import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { startBuiltRemoteNodeRuntime, startRemoteNodeRuntime } from "./remote-node-runtime.js";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-remote-runtime-"));
  await mkdir(path.join(root, resourceId), { recursive: true });
  await writeFile(path.join(root, resourceId, storageKey), "console.log('remote');");
  return root;
}

function deploymentInput(storageRoot: string, fetchImpl: typeof fetch) {
  const secret = encryptEnvironmentSecret("private-value", processEnvironment, `${resourceId}:APP_SECRET`);
  return {
    resourceId,
    deploymentId,
    storageRoot,
    files: [{ originalName: "server.js", storageKey }],
    validation,
    encryptedVariables: [{ name: "APP_SECRET", ...secret }],
    processEnvironment,
    hostingUserId,
    agent: {
      baseUrl: "https://runtime.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      fetchImpl,
    },
  };
}

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(input instanceof Request ? input.url : input.toString()), init ?? {})) as typeof fetch;
}

test("uploads the verified bundle before requesting remote runtime startup", async () => {
  const root = await fixture();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = fakeFetch((url, init) => {
    calls.push({ url, init });
    if (init.method === "PUT") {
      const bytes = Buffer.from(init.body as Uint8Array);
      assert.equal(bytes.subarray(0, 8).toString("ascii"), "DSQART01");
      return Response.json({ artifactId: deploymentId, accepted: true });
    }
    assert.equal(url.pathname, "/v1/runtimes");
    const body = JSON.parse(String(init.body)) as {
      deploymentId: string;
      artifact: { sha256: string; sizeBytes: number };
      runtime: { environment: Record<string, string> };
    };
    assert.equal(body.deploymentId, deploymentId);
    assert.match(body.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(body.artifact.sizeBytes > 0);
    assert.equal(body.runtime.environment.APP_SECRET, "private-value");
    assert.equal(body.runtime.environment.D_DATABASE_PASSWORD, databasePassword);
    assert.equal(body.runtime.environment.D_DATABASE_RESOURCE_ID, databaseResourceId);
    assert.equal("HOSTING_SECRETS_KEY" in body.runtime.environment, false);
    return Response.json({ resourceId, deploymentId, state: "running" }, { status: 201 });
  });

  try {
    const result = await startRemoteNodeRuntime(deploymentInput(root, fetchImpl), async () => approvedDatabaseConnection());
    assert.deepEqual(result, {
      resourceId,
      deploymentId,
      artifactId: deploymentId,
      fileCount: 1,
      state: "running",
    });
    assert.deepEqual(calls.map((call) => [call.init.method, call.url.pathname]), [
      ["PUT", `/v1/artifacts/${deploymentId}`],
      ["POST", "/v1/runtimes"],
    ]);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a remotely accepted artifact if runtime creation fails", async () => {
  const root = await fixture();
  const paths: string[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    paths.push(`${init.method} ${url.pathname}`);
    if (init.method === "PUT") {
      return Response.json({ artifactId: deploymentId, accepted: true });
    }
    if (init.method === "POST") {
      return new Response("internal failure", { status: 500 });
    }
    if (url.pathname === `/v1/runtimes/${resourceId}/${deploymentId}`) {
      return new Response(null, { status: 404 });
    }
    return Response.json({ artifactId: deploymentId, deleted: true });
  });

  try {
    await assert.rejects(
      startRemoteNodeRuntime(deploymentInput(root, fetchImpl), async () => null),
      /HTTP 500/,
    );
    assert.deepEqual(paths, [
      `PUT /v1/artifacts/${deploymentId}`,
      "POST /v1/runtimes",
      `DELETE /v1/runtimes/${resourceId}`,
      `DELETE /v1/artifacts/${deploymentId}`,
    ]);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not request runtime creation when artifact upload is rejected", async () => {
  const root = await fixture();
  const paths: string[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    paths.push(`${init.method} ${url.pathname}`);
    return new Response("rejected", { status: 413 });
  });

  try {
    await assert.rejects(
      startRemoteNodeRuntime(deploymentInput(root, fetchImpl), async () => null),
      /upload failed with HTTP 413/,
    );
    assert.deepEqual(paths, [`PUT /v1/artifacts/${deploymentId}`]);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("uploads source, builds remotely, starts only the built artifact, then removes source", async () => {
  const root = await fixture();
  const paths: string[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    paths.push(`${init.method} ${url.pathname}`);
    if (init.method === "PUT") {
      assert.equal(Buffer.from(init.body as Uint8Array).subarray(0, 8).toString("ascii"), "DSQART01");
      return Response.json({ artifactId: url.pathname.split("/").at(-1), accepted: true });
    }
    if (url.pathname === "/v1/builds") {
      const request = JSON.parse(String(init.body)) as { sourceArtifactId: string; deploymentId: string };
      assert.notEqual(request.sourceArtifactId, request.deploymentId);
      assert.equal(request.deploymentId, deploymentId);
      return Response.json({
        artifact: { artifactId: deploymentId, sha256: "c".repeat(64), sizeBytes: 4096, fileCount: 4 },
        output: "[install] done\\n[build] done",
      }, { status: 201 });
    }
    if (url.pathname === "/v1/runtimes") {
      const request = JSON.parse(String(init.body)) as { artifact: { artifactId: string; fileCount: number } };
      assert.equal(request.artifact.artifactId, deploymentId);
      assert.equal(request.artifact.fileCount, 4);
      return Response.json({ resourceId, deploymentId, state: "running" }, { status: 201 });
    }
    return Response.json({ artifactId: url.pathname.split("/").at(-1), deleted: true });
  });

  try {
    const result = await startBuiltRemoteNodeRuntime(
      deploymentInput(root, fetchImpl),
      async () => approvedDatabaseConnection(),
    );
    assert.equal(result.state, "running");
    assert.equal(result.artifactId, deploymentId);
    assert.equal(result.fileCount, 4);
    assert.match(result.buildOutput, /build/);
    assert.equal(paths.length, 4);
    assert.match(paths[0]!, /^PUT \/v1\/artifacts\//);
    assert.equal(paths[1], "POST /v1/builds");
    assert.equal(paths[2], "POST /v1/runtimes");
    assert.match(paths[3]!, /^DELETE \/v1\/artifacts\//);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the temporary source artifact when remote build fails", async () => {
  const root = await fixture();
  const paths: string[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    paths.push(`${init.method} ${url.pathname}`);
    if (init.method === "PUT") {
      return Response.json({ artifactId: url.pathname.split("/").at(-1), accepted: true });
    }
    if (url.pathname === "/v1/builds") return new Response("build failed", { status: 422 });
    if (init.method === "GET") return new Response(null, { status: 404 });
    return Response.json({ artifactId: url.pathname.split("/").at(-1), deleted: true });
  });
  try {
    await assert.rejects(
      startBuiltRemoteNodeRuntime(deploymentInput(root, fetchImpl), async () => null),
      /HTTP 422/,
    );
    assert.equal(paths.length, 5);
    assert.match(paths[0]!, /^PUT \/v1\/artifacts\//);
    assert.equal(paths[1], "POST /v1/builds");
    assert.equal(paths[2], `GET /v1/runtimes/${resourceId}`);
    assert.equal(paths[3], `DELETE /v1/artifacts/${deploymentId}`);
    assert.match(paths[4]!, /^DELETE \/v1\/artifacts\//);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
