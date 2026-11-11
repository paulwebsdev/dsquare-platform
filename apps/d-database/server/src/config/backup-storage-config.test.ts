import test from "node:test";
import assert from "node:assert/strict";
import { getDatabaseBackupStorageConfig } from "./backup-storage-config.js";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  D_DATABASE_BACKUP_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  D_DATABASE_BACKUP_BUCKET: "dsquare-database-backups",
  D_DATABASE_BACKUP_ACCESS_KEY_ID: "access-key",
  D_DATABASE_BACKUP_SECRET_ACCESS_KEY: "secret-key",
};

test("backup storage remains disabled when no provider settings are supplied", () => {
  assert.equal(getDatabaseBackupStorageConfig({ NODE_ENV: "production" }), null);
});

test("accepts a complete private S3-compatible provider configuration", () => {
  assert.deepEqual(getDatabaseBackupStorageConfig(base), {
    endpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "dsquare-database-backups",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    prefix: "dsquare-d-database",
  });
});

test("rejects partial provider configuration", () => {
  assert.throws(
    () => getDatabaseBackupStorageConfig({ ...base, D_DATABASE_BACKUP_SECRET_ACCESS_KEY: "" }),
    /Incomplete D Database backup storage configuration/,
  );
});

test("requires HTTPS for production endpoints", () => {
  assert.throws(
    () => getDatabaseBackupStorageConfig({ ...base, D_DATABASE_BACKUP_ENDPOINT: "http://storage.example.com" }),
    /must use HTTPS in production/,
  );
});

test("rejects unsafe object prefixes", () => {
  assert.throws(
    () => getDatabaseBackupStorageConfig({ ...base, D_DATABASE_BACKUP_PREFIX: "../other-product" }),
    /unsafe path/,
  );
});
