import assert from "node:assert/strict";
import test from "node:test";
import { changeRuntimeAgentRuntimeState, checkRuntimeAgentHealth, createRuntimeAgentRuntime, deleteRuntimeAgentArtifact, deleteRuntimeAgentRuntime, getRuntimeAgentRuntime, requestRuntimeAgent } from "./runtime-agent-client.js";

const options = {
  baseUrl: "https://runtime.example.com",
  secret: "0123456789abcdef0123456789abcdef",
};

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(input instanceof Request ? input.url : input.toString()), init ?? {})) as typeof fetch;
}

test("sends the exact JSON body with signed headers and parses the response", async () => {
  let received: RequestInit | undefined;
  const result = await requestRuntimeAgent<{ id: string }>(
    { ...options, fetchImpl: fakeFetch((_url, init) => {
      received = init;
      return Response.json({ id: "runtime-1" });
    }) },
    { method: "POST", path: "/v1/runtimes", body: { deploymentId: "deploy-1" } },
  );
  assert.deepEqual(result, { id: "runtime-1" });
  assert.equal(received?.redirect, "manual");
  assert.equal(received?.body, JSON.stringify({ deploymentId: "deploy-1" }));
  assert.ok((received?.headers as Record<string, string>)["x-dsquare-signature"]);
});

test("rejects insecure endpoints, unsafe paths, and GET bodies before transport", async () => {
  const fetchImpl = fakeFetch(() => { throw new Error("must not call transport"); });
  await assert.rejects(requestRuntimeAgent({ ...options, baseUrl: "http://runtime.example.com", fetchImpl },
    { method: "GET", path: "/v1/health" }), /HTTPS/);
  for (const path of ["/v1/../admin", "/v1/runtimes?x=1", "/v1//evil"]) {
    await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl }, { method: "GET", path }));
  }
  await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl },
    { method: "GET", path: "/v1/health", body: { secret: "no" } }), /cannot include a body/);
});

test("does not follow redirects or expose remote error bodies", async () => {
  const redirect = fakeFetch(() => new Response(null, { status: 307, headers: { location: "https://evil.example" } }));
  await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl: redirect },
    { method: "GET", path: "/v1/health" }), /redirects are not permitted/);

  const failure = fakeFetch(() => new Response("sensitive internal details", { status: 500 }));
  await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl: failure },
    { method: "GET", path: "/v1/health" }), (error: Error) =>
      error.message.includes("HTTP 500") && !error.message.includes("sensitive"));
});

test("bounds response size and validates JSON", async () => {
  const invalid = fakeFetch(() => new Response("not-json"));
  await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl: invalid },
    { method: "GET", path: "/v1/health" }), /invalid JSON/);
  const oversized = fakeFetch(() => new Response("x".repeat(1024 * 1024 + 1)));
  await assert.rejects(requestRuntimeAgent({ ...options, fetchImpl: oversized },
    { method: "GET", path: "/v1/health" }), /exceeded the permitted size/);
});

test("rejects unreasonable timeouts", async () => {
  await assert.rejects(requestRuntimeAgent({ ...options, timeoutMs: 60_001, fetchImpl: fakeFetch(() => Response.json({})) },
    { method: "GET", path: "/v1/health" }), /timeout/);
});

test("uploads binary artifacts with an HMAC signature and validates acceptance", async () => {
  let received: RequestInit | undefined;
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const result = await (await import("./runtime-agent-client.js")).uploadRuntimeAgentArtifact(
    { ...options, fetchImpl: fakeFetch((_url, init) => {
      received = init;
      return Response.json({
        artifactId: "123e4567-e89b-42d3-a456-426614174002",
        accepted: true,
      });
    }) },
    "123e4567-e89b-42d3-a456-426614174002",
    bytes,
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(Buffer.from(received?.body as Uint8Array), bytes);
  assert.equal(received?.method, "PUT");
  assert.equal((received?.headers as Record<string, string>)["content-type"],
    "application/vnd.dsquare.runtime-artifact");
  assert.ok((received?.headers as Record<string, string>)["x-dsquare-signature"]);
});

test("rejects invalid artifact upload identifiers, sizes, and unconfirmed acceptance", async () => {
  const fetchImpl = fakeFetch(() => Response.json({ accepted: true }));
  const upload = (await import("./runtime-agent-client.js")).uploadRuntimeAgentArtifact;
  await assert.rejects(upload({ ...options, fetchImpl }, "bad", Buffer.from("x")), /ID is invalid/);
  await assert.rejects(upload({ ...options, fetchImpl }, "123e4567-e89b-42d3-a456-426614174002", new Uint8Array()), /between 1 byte/);
  await assert.rejects(upload({ ...options, fetchImpl },
    "123e4567-e89b-42d3-a456-426614174002", Buffer.from("x")), /did not confirm/);
});


test("checks authenticated runtime health and validates capability fields", async () => {
  const health = await checkRuntimeAgentHealth({
    ...options,
    fetchImpl: fakeFetch((_url, init) => {
      assert.equal(init.method, "GET");
      return Response.json({
        status: "ready",
        providerConfigured: false,
        executionEnabled: false,
      });
    }),
  });
  assert.deepEqual(health, {
    status: "ready",
    providerConfigured: false,
    executionEnabled: false,
  });

  await assert.rejects(checkRuntimeAgentHealth({
    ...options,
    fetchImpl: fakeFetch(() => Response.json({
      status: "ready",
      providerConfigured: true,
      executionEnabled: "yes",
    })),
  }), /invalid health response/);
});


const RESOURCE_ID = "123e4567-e89b-42d3-a456-426614174001";
const DEPLOYMENT_ID = "123e4567-e89b-42d3-a456-426614174002";

test("creates and reads a runtime using validated typed responses", async () => {
  const createInput = {
    resourceId: RESOURCE_ID,
    deploymentId: DEPLOYMENT_ID,
    artifact: { artifactId: DEPLOYMENT_ID, sha256: "a".repeat(64), sizeBytes: 128, fileCount: 1 },
    runtime: {
      name: `dsquare-site-${RESOURCE_ID}`,
      image: "node:22-bookworm-slim",
      workingDirectory: "/app" as const,
      command: ["npm", "start"] as ["npm", "start"],
      environment: { PORT: "3000", NODE_ENV: "production" },
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pidsLimit: 128,
      user: "10001:10001" as const,
      readOnlyRootFilesystem: true as const,
      capDrop: ["ALL"] as ["ALL"],
      securityOpt: ["no-new-privileges:true"] as ["no-new-privileges:true"],
      tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" as const },
    },
  };
  const created = await createRuntimeAgentRuntime({
    ...options,
    fetchImpl: fakeFetch((_url, init) => {
      assert.equal(init.method, "POST");
      return Response.json({ resourceId: RESOURCE_ID, deploymentId: DEPLOYMENT_ID, state: "running" }, { status: 201 });
    }),
  }, createInput);
  assert.equal(created.state, "running");

  const current = await getRuntimeAgentRuntime({
    ...options,
    fetchImpl: fakeFetch((url, init) => {
      assert.equal(url.pathname, `/v1/runtimes/${RESOURCE_ID}`);
      assert.equal(init.method, "GET");
      return Response.json({ resourceId: RESOURCE_ID, deploymentId: DEPLOYMENT_ID, state: "stopped" });
    }),
  }, RESOURCE_ID);
  assert.equal(current.state, "stopped");
});

test("validates runtime lifecycle and artifact deletion confirmations", async () => {
  const stop = await changeRuntimeAgentRuntimeState({
    ...options,
    fetchImpl: fakeFetch((_url, init) => {
      assert.equal(init.method, "POST");
      return Response.json({ resourceId: RESOURCE_ID, state: "stopped" });
    }),
  }, RESOURCE_ID, "stop");
  assert.equal(stop.state, "stopped");

  const restart = await changeRuntimeAgentRuntimeState({
    ...options,
    fetchImpl: fakeFetch(() => Response.json({ resourceId: RESOURCE_ID, state: "running" })),
  }, RESOURCE_ID, "restart");
  assert.equal(restart.state, "running");

  const removed = await deleteRuntimeAgentRuntime({
    ...options,
    fetchImpl: fakeFetch((_url, init) => {
      assert.equal(init.method, "DELETE");
      return Response.json({ resourceId: RESOURCE_ID, deleted: true });
    }),
  }, RESOURCE_ID);
  assert.equal(removed.deleted, true);

  const artifact = await deleteRuntimeAgentArtifact({
    ...options,
    fetchImpl: fakeFetch((url) => {
      assert.equal(url.pathname, `/v1/artifacts/${DEPLOYMENT_ID}`);
      return Response.json({ artifactId: DEPLOYMENT_ID, deleted: true });
    }),
  }, DEPLOYMENT_ID);
  assert.equal(artifact.deleted, true);
});

test("rejects invalid resource identifiers and unconfirmed lifecycle results", async () => {
  const fetchImpl = fakeFetch(() => Response.json({ resourceId: RESOURCE_ID, state: "running" }));
  await assert.rejects(getRuntimeAgentRuntime({ ...options, fetchImpl }, "not-a-uuid"), /ID is invalid/);
  await assert.rejects(changeRuntimeAgentRuntimeState({ ...options, fetchImpl }, RESOURCE_ID, "stop"),
    /did not confirm/);
  await assert.rejects(createRuntimeAgentRuntime({ ...options, fetchImpl }, {
    resourceId: "invalid",
    deploymentId: DEPLOYMENT_ID,
    artifact: { artifactId: DEPLOYMENT_ID, sha256: "a".repeat(64), sizeBytes: 128, fileCount: 1 },
    runtime: {} as never,
  }), /ID is invalid/);
});
