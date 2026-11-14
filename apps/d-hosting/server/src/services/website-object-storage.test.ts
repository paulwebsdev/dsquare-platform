import assert from "node:assert/strict";
import test from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { websiteObjectStorage } from "./website-object-storage.js";
import { assertWebsiteObjectKeyScope, buildWebsiteObjectKey } from "./website-object-storage.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  resourceId: "33333333-3333-4333-8333-333333333333",
  objectId: "44444444-4444-4444-8444-444444444444",
};

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


test("S3 adapter uploads encrypted objects, retrieves bytes, deletes, and fails closed on provider errors", async () => {
  const env = {
    NODE_ENV: process.env.NODE_ENV,
    HOSTING_OBJECT_STORAGE_BUCKET: process.env.HOSTING_OBJECT_STORAGE_BUCKET,
    HOSTING_OBJECT_STORAGE_REGION: process.env.HOSTING_OBJECT_STORAGE_REGION,
    HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID: process.env.HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID,
    HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY: process.env.HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY,
    HOSTING_OBJECT_STORAGE_ENDPOINT: process.env.HOSTING_OBJECT_STORAGE_ENDPOINT,
  };
  const originalSend = S3Client.prototype.send;
  const commands: unknown[] = [];
  let fail = false;
  process.env.NODE_ENV = "test";
  process.env.HOSTING_OBJECT_STORAGE_BUCKET = "dsquare-test-bucket";
  process.env.HOSTING_OBJECT_STORAGE_REGION = "us-east-1";
  process.env.HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID = "test-access-key";
  process.env.HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY = "test-secret-key";
  delete process.env.HOSTING_OBJECT_STORAGE_ENDPOINT;
  S3Client.prototype.send = (async (command: unknown) => {
    commands.push(command);
    if (fail) throw new Error("provider unavailable");
    if (command instanceof GetObjectCommand) {
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    }
    if (command instanceof PutObjectCommand || command instanceof DeleteObjectCommand) return {};
    throw new Error("Unexpected S3 command.");
  }) as S3Client["send"];

  try {
    const key = await websiteObjectStorage.put(base, Buffer.from([1, 2, 3]), "image/png");
    assert.equal(key, buildWebsiteObjectKey(base));
    const put = commands[0] as PutObjectCommand;
    assert.ok(put instanceof PutObjectCommand);
    assert.equal(put.input.ServerSideEncryption, "AES256");
    assert.equal(put.input.Metadata?.owner, base.ownerId);
    assert.deepEqual(await websiteObjectStorage.get(key, base), Buffer.from([1, 2, 3]));
    assert.ok(commands[1] instanceof GetObjectCommand);
    await websiteObjectStorage.delete(key, base);
    assert.ok(commands[2] instanceof DeleteObjectCommand);
    await assert.rejects(
      websiteObjectStorage.get(key, { ...base, ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      /does not belong/,
    );
    fail = true;
    await assert.rejects(
      websiteObjectStorage.put({ ...base, objectId: "55555555-5555-4555-8555-555555555555" }, Buffer.from([4]), "image/png"),
      /provider unavailable/,
    );
  } finally {
    S3Client.prototype.send = originalSend;
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
