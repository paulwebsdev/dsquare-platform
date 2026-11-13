import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersistentBackupObjectStoreFromEnvironment, persistentBackupObjectKey } from "./persistent-storage-object-store.js";

const store = { client: {} as never, bucket: "dsquare-backups", prefix: "dsquare-hosting" };
const resourceId = "11111111-1111-4111-8111-111111111111";
const backupId = "0123456789abcdef0123456789abcdef";

test("requires a complete offsite bucket configuration and safe HTTPS endpoints", () => {
  assert.equal(createPersistentBackupObjectStoreFromEnvironment({}), undefined);
  assert.throws(() => createPersistentBackupObjectStoreFromEnvironment({ RUNTIME_AGENT_BACKUP_S3_BUCKET: "bucket" }), /configured together/);
  assert.throws(() => createPersistentBackupObjectStoreFromEnvironment({
    RUNTIME_AGENT_BACKUP_S3_BUCKET: "bucket", RUNTIME_AGENT_BACKUP_S3_REGION: "us-east-1",
    RUNTIME_AGENT_BACKUP_S3_ENDPOINT: "http://storage.internal",
  }), /HTTPS/);
  const store = createPersistentBackupObjectStoreFromEnvironment({
    RUNTIME_AGENT_BACKUP_S3_BUCKET: "bucket", RUNTIME_AGENT_BACKUP_S3_REGION: "us-east-1",
  });
  assert.ok(store);
  store.client.destroy();
});

test("creates deterministic private object keys scoped by website and backup ID", () => {
  assert.equal(persistentBackupObjectKey(store, resourceId, backupId),
    `dsquare-hosting/${resourceId}/${backupId}.dsqbak`);
});

test("rejects unsafe resource and backup identifiers before object storage access", () => {
  assert.throws(() => persistentBackupObjectKey(store, "../escape", backupId), /identity is invalid/);
  assert.throws(() => persistentBackupObjectKey(store, resourceId, "../../escape"), /identity is invalid/);
});
