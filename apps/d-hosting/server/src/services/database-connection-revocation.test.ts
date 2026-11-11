import assert from "node:assert/strict";
import test from "node:test";
import { requestDatabaseResourceRevocation } from "./database-connection-revocation.js";

const apiUrl = new URL("https://database.example");

test("sends authenticated resource revocation to the D Database integration endpoint", async () => {
  let requestedUrl: URL | undefined;
  let requestedInit: RequestInit | undefined;
  const result = await requestDatabaseResourceRevocation(
    "09800acb-a6c6-42d0-93f0-9d8aa73c251d",
    apiUrl,
    "dsquare-d-hosting",
    "private-client-secret",
    async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({ success: true, revoked: true }), { status: 200 });
    },
  );

  assert.equal(result, true);
  assert.equal(requestedUrl?.toString(), "https://database.example/api/v1/integrations/hosting/revoke");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.headers && (requestedInit.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    clientId: "dsquare-d-hosting",
    clientSecret: "private-client-secret",
    resourceId: "09800acb-a6c6-42d0-93f0-9d8aa73c251d",
  });
});

test("reports unsuccessful HTTP responses and unsuccessful payloads as failed revocations", async () => {
  const httpFailure = await requestDatabaseResourceRevocation(
    "resource", apiUrl, "client", "secret",
    async () => new Response(JSON.stringify({ success: true }), { status: 503 }),
  );
  const payloadFailure = await requestDatabaseResourceRevocation(
    "resource", apiUrl, "client", "secret",
    async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
  );
  const invalidJson = await requestDatabaseResourceRevocation(
    "resource", apiUrl, "client", "secret",
    async () => new Response("not-json", { status: 200 }),
  );
  assert.equal(httpFailure, false);
  assert.equal(payloadFailure, false);
  assert.equal(invalidJson, false);
});

test("fails closed when the integration secret is missing", async () => {
  let called = false;
  const result = await requestDatabaseResourceRevocation(
    "resource", apiUrl, "client", "",
    async () => {
      called = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  );
  assert.equal(result, false);
  assert.equal(called, false);
});

test("propagates network failures so callers can handle retry or compensation", async () => {
  await assert.rejects(
    requestDatabaseResourceRevocation(
      "resource", apiUrl, "client", "secret",
      async () => { throw new Error("network unavailable"); },
    ),
    /network unavailable/,
  );
});
