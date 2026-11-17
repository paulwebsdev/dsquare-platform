import test from "node:test";
import assert from "node:assert/strict";
import { getBackupObjectKey } from "./s3-compatible-backup-storage.js";

test("builds a deterministic product- and tenant-scoped backup key", () => {
  assert.equal(
    getBackupObjectKey(
      "dsquare-d-database",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    "dsquare-d-database/projects/11111111-1111-4111-8111-111111111111/resources/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.dump",
  );
});

test("rejects untrusted identifiers and unsafe prefixes", () => {
  assert.throws(() => getBackupObjectKey("../hosting", "bad", "bad", "bad"), /UUIDs/);
  assert.throws(() => getBackupObjectKey("../hosting", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"), /prefix/);
});


import { S3CompatibleBackupStorage } from "./s3-compatible-backup-storage.js";
import type { DatabaseBackupStorageConfig } from "../config/backup-storage-config.js";

const storageConfig: DatabaseBackupStorageConfig = {
  endpoint: "https://storage.example.test",
  region: "us-east-2",
  bucket: "private-backups",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  prefix: "dsquare/database",
};

test("uploads, downloads and deletes an object using signed S3-compatible requests", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const payload = Buffer.from("backup archive bytes");
  const storage = new S3CompatibleBackupStorage(storageConfig, async (input, init = {}) => {
    requests.push({ url: new URL(String(input)), init });
    if (init.method === "GET") return new Response(payload, { status: 200 });
    return new Response(null, { status: 200 });
  });

  const uploaded = await storage.putObject("dsquare/database/platform/test.dump", payload);
  const downloaded = await storage.getObject("dsquare/database/platform/test.dump");
  await storage.deleteObject("dsquare/database/platform/test.dump");

  assert.equal(uploaded.sizeBytes, payload.length);
  assert.equal(uploaded.checksumSha256, downloaded.checksumSha256);
  assert.deepEqual(downloaded.body, payload);
  assert.deepEqual(requests.map((request) => request.init.method), ["PUT", "GET", "DELETE"]);
  assert.equal(requests[0].url.pathname, "/private-backups/dsquare/database/platform/test.dump");
  for (const request of requests) {
    assert.match(String((request.init.headers as Record<string, string>).authorization), /^AWS4-HMAC-SHA256 /);
    assert.ok((request.init.headers as Record<string, string>)["x-amz-content-sha256"]);
  }
});

test("treats missing objects as successfully deleted but rejects other storage failures", async () => {
  const missing = new S3CompatibleBackupStorage(storageConfig, async () => new Response(null, { status: 404 }));
  await missing.deleteObject("dsquare/database/platform/missing.dump");

  const denied = new S3CompatibleBackupStorage(storageConfig, async () => new Response(null, { status: 403 }));
  await assert.rejects(denied.deleteObject("dsquare/database/platform/denied.dump"), /HTTP 403/);
  await assert.rejects(denied.getObject("dsquare/database/platform/denied.dump"), /HTTP 403/);
  await assert.rejects(denied.putObject("dsquare/database/platform/denied.dump", Buffer.from("x")), /HTTP 403/);
});

test("rejects traversal and malformed object keys before making a storage request", async () => {
  let requests = 0;
  const storage = new S3CompatibleBackupStorage(storageConfig, async () => {
    requests++;
    return new Response(null, { status: 200 });
  });
  await assert.rejects(storage.putObject("../outside.dump", Buffer.from("x")), /Invalid backup object key/);
  await assert.rejects(storage.getObject("dsquare//empty.dump"), /Invalid backup object key/);
  await assert.rejects(storage.deleteObject("/absolute.dump"), /Invalid backup object key/);
  assert.equal(requests, 0);
});
