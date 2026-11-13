import assert from "node:assert/strict";
import test from "node:test";
import { createDDatabaseClient } from "./index.js";

test("requires HTTPS outside localhost", () => {
  assert.throws(() => createDDatabaseClient({
    baseUrl: "http://example.com",
    apiKey: "dsq_live_test",
    projectId: "project",
    resourceId: "resource",
  }), /HTTPS/);
});

test("rejects keys without the D Database prefix", () => {
  assert.throws(() => createDDatabaseClient({
    baseUrl: "https://database.example.com",
    apiKey: "invalid",
    projectId: "project",
    resourceId: "resource",
  }), /API key/);
});

test("lists tables with bearer authorization", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({ success: true, tables: ["customers"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = createDDatabaseClient({
      baseUrl: "https://database.example.com/",
      apiKey: "dsq_live_example",
      projectId: "project-1",
      resourceId: "resource-1",
    });
    assert.deepEqual(await client.listTables(), ["customers"]);
    assert.equal(requestUrl, "https://database.example.com/api/v1/data/project-1/resource-1/tables");
    assert.equal(authorization, "Bearer dsq_live_example");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("updates rows using PATCH with explicit filters", async () => {
  const originalFetch = globalThis.fetch;
  let requestMethod = "";
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestMethod = init?.method || "";
    requestBody = String(init?.body || "");
    return new Response(JSON.stringify({ success: true, updatedCount: 1, rows: [{ id: "1", name: "Ada" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createDDatabaseClient({ baseUrl: "https://database.example.com", apiKey: "dsq_live_example", projectId: "p", resourceId: "r" });
    const result = await client.update("customers", { name: "Ada" }, { id: "1" });
    assert.equal(requestMethod, "PATCH");
    assert.deepEqual(JSON.parse(requestBody), { values: { name: "Ada" }, where: { id: "1" } });
    assert.equal(result.updatedCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("deletes rows using DELETE with explicit filters", async () => {
  const originalFetch = globalThis.fetch;
  let requestMethod = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestMethod = init?.method || "";
    return new Response(JSON.stringify({ success: true, deletedCount: 1, rows: [{ id: "1" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createDDatabaseClient({ baseUrl: "https://database.example.com", apiKey: "dsq_live_example", projectId: "p", resourceId: "r" });
    const result = await client.delete("customers", { id: "1" });
    assert.equal(requestMethod, "DELETE");
    assert.equal(result.deletedCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});


test("reads cursor pages with an encoded continuation cursor", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({
      success: true, table: "customers", limit: 2,
      rows: [{ id: "3" }, { id: "4" }], hasMore: true, nextCursor: "eyJpZCI6IjQifQ",
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createDDatabaseClient({ baseUrl: "https://database.example.com", apiKey: "dsq_live_example", projectId: "p", resourceId: "r" });
    const result = await client.selectCursor("customers", { limit: 2, cursor: "opaque+/cursor" });
    assert.match(requestUrl, /\/tables\/customers\/rows\/cursor\?limit=2&cursor=opaque%2B%2Fcursor$/);
    assert.equal(authorization, "Bearer dsq_live_example");
    assert.equal(result.hasMore, true);
    assert.equal(result.rows.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("submits bounded transaction operations as one authenticated POST", async () => {
  const originalFetch = globalThis.fetch;
  let requestMethod = "";
  let requestBody = "";
  let authorization = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestMethod = init?.method || "";
    requestBody = String(init?.body || "");
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({
      success: true, committed: true, operationCount: 2,
      results: [
        { type: "insert", table: "customers", affectedCount: 1, rows: [{ id: "1" }] },
        { type: "update", table: "customers", affectedCount: 1, rows: [{ id: "1" }] },
      ],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createDDatabaseClient({ baseUrl: "https://database.example.com", apiKey: "dsq_live_example", projectId: "p", resourceId: "r" });
    const operations = [
      { type: "insert" as const, table: "customers", values: { name: "Ada" } },
      { type: "update" as const, table: "customers", values: { name: "Grace" }, where: { id: "1" } },
    ];
    const result = await client.transaction(operations);
    assert.equal(requestMethod, "POST");
    assert.equal(requestBody, JSON.stringify({ operations }));
    assert.equal(authorization, "Bearer dsq_live_example");
    assert.equal(result.committed, true);
    assert.equal(result.operationCount, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("surfaces transaction rollback errors from the API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: false, committed: false, message: "The transaction failed; no operations were committed.",
  }), { status: 409 })) as typeof fetch;
  try {
    const client = createDDatabaseClient({ baseUrl: "https://database.example.com", apiKey: "dsq_live_example", projectId: "p", resourceId: "r" });
    await assert.rejects(client.transaction([{ type: "delete", table: "customers", where: { id: "1" } }]), /no operations were committed/i);
  } finally { globalThis.fetch = originalFetch; }
});
