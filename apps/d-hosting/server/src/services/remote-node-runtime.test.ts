import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { startRemoteNodeRuntime } from "./remote-node-runtime.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const storageKey = "123e4567-e89b-42d3-a456-426614174002";
const key = Buffer.alloc(32, 9).toString("base64");
const processEnvironment = { HOSTING_SECRETS_KEY: key };
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
    assert.equal("HOSTING_SECRETS_KEY" in body.runtime.environment, false);
    return Response.json({ containerId: "remote-runtime-1" });
  });

  try {
    const result = await startRemoteNodeRuntime(deploymentInput(root, fetchImpl));
    assert.deepEqual(result, {
      containerId: "remote-runtime-1",
      artifactId: deploymentId,
      fileCount: 1,
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
    return Response.json({ artifactId: deploymentId, deleted: true });
  });

  try {
    await assert.rejects(
      startRemoteNodeRuntime(deploymentInput(root, fetchImpl)),
      /HTTP 500/,
    );
    assert.deepEqual(paths, [
      `PUT /v1/artifacts/${deploymentId}`,
      "POST /v1/runtimes",
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
      startRemoteNodeRuntime(deploymentInput(root, fetchImpl)),
      /upload failed with HTTP 413/,
    );
    assert.deepEqual(paths, [`PUT /v1/artifacts/${deploymentId}`]);
    await assert.rejects(stat(path.join(root, resourceId, "runtime-artifacts", deploymentId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
