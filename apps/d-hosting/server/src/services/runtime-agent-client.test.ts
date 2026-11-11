import assert from "node:assert/strict";
import test from "node:test";
import { requestRuntimeAgent } from "./runtime-agent-client.js";

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
