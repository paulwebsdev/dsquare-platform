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


test("reads cursor pages with encoded continuation cursor and bearer authorization", async () => {
  const originalFetch = globalThis.fetch; let url = ""; let authorization = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input); authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({ success: true, table: "customers", limit: 2, rows: [{id:"3"}], hasMore: true, nextCursor: "next" }), {status:200});
  }) as typeof fetch;
  try {
    const client = createDDatabaseClient({baseUrl:"https://database.example.com",apiKey:"dsq_live_example",projectId:"p",resourceId:"r"});
    const result = await client.selectCursor("customers",{limit:2,cursor:"opaque+/cursor"});
    assert.match(url,/\/tables\/customers\/rows\/cursor\?limit=2&cursor=opaque%2B%2Fcursor$/);
    assert.equal(authorization,"Bearer dsq_live_example"); assert.equal(result.hasMore,true);
  } finally { globalThis.fetch = originalFetch; }
});

test("submits atomic transaction operations as one authenticated POST", async () => {
  const originalFetch = globalThis.fetch; let method = ""; let body = ""; let authorization = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    method=init?.method||""; body=String(init?.body||""); authorization=new Headers(init?.headers).get("authorization")||"";
    return new Response(JSON.stringify({success:true,committed:true,operationCount:1,results:[]}),{status:200});
  }) as typeof fetch;
  try {
    const client=createDDatabaseClient({baseUrl:"https://database.example.com",apiKey:"dsq_live_example",projectId:"p",resourceId:"r"});
    const operations=[{type:"insert" as const,table:"customers",values:{name:"Ada"}}];
    const result=await client.transaction(operations);
    assert.equal(method,"POST"); assert.equal(body,JSON.stringify({operations}));
    assert.equal(authorization,"Bearer dsq_live_example"); assert.equal(result.committed,true);
  } finally { globalThis.fetch=originalFetch; }
});

test("surfaces transaction rollback errors", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(JSON.stringify({success:false,committed:false,message:"No operations were committed."}),{status:409})) as typeof fetch;
  try {
    const client=createDDatabaseClient({baseUrl:"https://database.example.com",apiKey:"dsq_live_example",projectId:"p",resourceId:"r"});
    await assert.rejects(client.transaction([{type:"delete",table:"customers",where:{id:"1"}}]),/No operations were committed/);
  } finally { globalThis.fetch=originalFetch; }
});
