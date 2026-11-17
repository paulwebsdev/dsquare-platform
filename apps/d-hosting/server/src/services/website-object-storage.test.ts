import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWebsiteObjectKeyScope,
  buildWebsiteObjectKey,
  createPostgresWebsiteObjectStorage,
  type WebsiteObjectStorageQueryable,
} from "./website-object-storage.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  resourceId: "33333333-3333-4333-8333-333333333333",
  objectId: "44444444-4444-4444-8444-444444444444",
};

function createFakeStorageDatabase(): {
  queryable: WebsiteObjectStorageQueryable;
  objects: Map<string, { ownerId: string; projectId: string; resourceId: string; body: Buffer; sizeBytes: number }>;
  queries: string[];
} {
  const objects = new Map<string, { ownerId: string; projectId: string; resourceId: string; body: Buffer; sizeBytes: number }>();
  const queries: string[] = [];
  const queryable: WebsiteObjectStorageQueryable = {
    async query(text, values = []) {
      queries.push(text);
      if (text.includes("INSERT INTO hosting_object_blobs")) {
        const [key, ownerId, projectId, resourceId, _objectId, _contentType, sizeBytes, body] = values;
        objects.set(String(key), {
          ownerId: String(ownerId),
          projectId: String(projectId),
          resourceId: String(resourceId),
          body: Buffer.from(body as Buffer),
          sizeBytes: Number(sizeBytes),
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SELECT body, size_bytes FROM hosting_object_blobs")) {
        const [key, ownerId, projectId, resourceId] = values.map(String);
        const stored = objects.get(key);
        if (!stored || stored.ownerId !== ownerId || stored.projectId !== projectId || stored.resourceId !== resourceId) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ body: stored.body, size_bytes: stored.sizeBytes }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM hosting_object_blobs")) {
        const [key, ownerId, projectId, resourceId] = values.map(String);
        const stored = objects.get(key);
        if (stored && stored.ownerId === ownerId && stored.projectId === projectId && stored.resourceId === resourceId) {
          objects.delete(key);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error("Unexpected storage query.");
    },
  };
  return { queryable, objects, queries };
}

test("website object keys are scoped by owner, project, website, and immutable object ID", () => {
  assert.equal(
    buildWebsiteObjectKey(base),
    "owners/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/websites/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444",
  );
  assert.notEqual(
    buildWebsiteObjectKey({ ...base, ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    buildWebsiteObjectKey(base),
  );
  assert.notEqual(
    buildWebsiteObjectKey({ ...base, resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    buildWebsiteObjectKey(base),
  );
});

test("website object keys reject invalid identifiers", () => {
  assert.throws(() => buildWebsiteObjectKey({ ...base, ownerId: "../other-owner" }), /identity is invalid/);
  assert.throws(() => buildWebsiteObjectKey({ ...base, objectId: "not-a-uuid" }), /identity is invalid/);
});

test("rejects cross-owner, cross-project, and cross-website object reads", () => {
  const key = buildWebsiteObjectKey(base);
  assert.doesNotThrow(() => assertWebsiteObjectKeyScope(key, base));
  assert.throws(() => assertWebsiteObjectKeyScope(key, { ...base, ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), /does not belong/);
  assert.throws(() => assertWebsiteObjectKeyScope(key, { ...base, projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), /does not belong/);
  assert.throws(() => assertWebsiteObjectKeyScope(key, { ...base, resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), /does not belong/);
});

test("PostgreSQL storage persists, scopes, retrieves, and deletes website object bytes", async () => {
  const fake = createFakeStorageDatabase();
  const storage = createPostgresWebsiteObjectStorage(fake.queryable);
  const bytes = Buffer.from([1, 2, 3, 4]);
  const key = await storage.put(base, bytes, "image/png");

  assert.equal(key, buildWebsiteObjectKey(base));
  assert.equal(fake.objects.size, 1);
  assert.deepEqual(await storage.get(key, base), bytes);
  assert.ok(fake.queries.some(query => query.includes("owner_id = $2 AND project_id = $3 AND resource_id = $4")));

  await assert.rejects(
    storage.get(key, { ...base, ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    /does not belong/,
  );

  await storage.delete(key, base);
  assert.equal(fake.objects.size, 0);
  await assert.rejects(storage.get(key, base), (error: unknown) =>
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("PostgreSQL storage rejects empty and oversized objects before writing", async () => {
  const fake = createFakeStorageDatabase();
  const storage = createPostgresWebsiteObjectStorage(fake.queryable);
  await assert.rejects(storage.put(base, Buffer.alloc(0), "image/png"), /size is invalid/);
  await assert.rejects(storage.put(base, Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"), /size is invalid/);
  assert.equal(fake.objects.size, 0);
});
