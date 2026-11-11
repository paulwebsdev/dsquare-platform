import assert from "node:assert/strict";
import { test } from "node:test";
import { requestDatabaseResourceRevocation } from "./database-connection-revocation.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const apiUrl = new URL("https://database.example.test");

test("sends an authenticated resource revocation request", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await requestDatabaseResourceRevocation(
    resourceId, apiUrl, "hosting-client", "shared-secret",
    async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ success: true, revoked: true }), { status: 200 });
    },
  );

  assert.equal(result, true);
  assert.equal(requestUrl, "https://database.example.test/api/v1/integrations/hosting/revoke");
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    clientId: "hosting-client",
    clientSecret: "shared-secret",
    resourceId,
  });
});

test("returns false when the shared secret is missing", async () => {
  let called = false;
  const result = await requestDatabaseResourceRevocation(
    resourceId, apiUrl, "hosting-client", "",
    async () => {
      called = true;
      return new Response(null, { status: 200 });
    },
  );
  assert.equal(result, false);
  assert.equal(called, false);
});

test("returns false for unsuccessful HTTP responses", async () => {
  const result = await requestDatabaseResourceRevocation(
    resourceId, apiUrl, "hosting-client", "shared-secret",
    async () => new Response(JSON.stringify({ success: true }), { status: 503 }),
  );
  assert.equal(result, false);
});

test("returns false when the API does not confirm revocation", async () => {
  const result = await requestDatabaseResourceRevocation(
    resourceId, apiUrl, "hosting-client", "shared-secret",
    async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
  );
  assert.equal(result, false);
});

test("returns false for invalid JSON responses", async () => {
  const result = await requestDatabaseResourceRevocation(
    resourceId, apiUrl, "hosting-client", "shared-secret",
    async () => new Response("not-json", { status: 200 }),
  );
  assert.equal(result, false);
});

test("propagates network failures", async () => {
  await assert.rejects(
    requestDatabaseResourceRevocation(
      resourceId, apiUrl, "hosting-client", "shared-secret",
      async () => { throw new Error("network unavailable"); },
    ),
    /network unavailable/,
  );
});
