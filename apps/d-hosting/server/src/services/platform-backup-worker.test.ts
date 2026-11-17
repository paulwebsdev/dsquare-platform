import assert from "node:assert/strict";
import test from "node:test";
import { getHostingBackupConfig } from "./platform-backup-worker.js";

test("backup configuration is optional when no backup settings are supplied", () => {
  assert.equal(getHostingBackupConfig({} as NodeJS.ProcessEnv), null);
});

test("rejects partial backup storage configuration", () => {
  assert.throws(() => getHostingBackupConfig({ D_HOSTING_BACKUP_BUCKET: "private-bucket" } as NodeJS.ProcessEnv), /Incomplete D Hosting backup configuration/);
});

test("requires HTTPS for production backup storage", () => {
  assert.throws(() => getHostingBackupConfig({
    NODE_ENV: "production",
    D_HOSTING_BACKUP_ENDPOINT: "http://storage.example.com",
    D_HOSTING_BACKUP_BUCKET: "private-bucket",
    D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
    D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
  } as NodeJS.ProcessEnv), /must use HTTPS/);
});

test("rejects unsafe backup prefixes", () => {
  assert.throws(() => getHostingBackupConfig({
    D_HOSTING_BACKUP_ENDPOINT: "https://storage.example.com",
    D_HOSTING_BACKUP_BUCKET: "private-bucket",
    D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
    D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
    D_HOSTING_BACKUP_PREFIX: "../outside",
  } as NodeJS.ProcessEnv), /unsafe path/);
});

test("accepts a complete private HTTPS backup configuration", () => {
  const config = getHostingBackupConfig({
    NODE_ENV: "production",
    D_HOSTING_BACKUP_ENDPOINT: "https://storage.example.com",
    D_HOSTING_BACKUP_BUCKET: "private-bucket",
    D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
    D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
    D_HOSTING_BACKUP_PREFIX: "dsquare/hosting",
  } as NodeJS.ProcessEnv);
  assert.equal(config?.bucket, "private-bucket");
  assert.equal(config?.prefix, "dsquare/hosting");
});


test("rejects backup endpoints containing credentials or URL parameters", () => {
  for (const endpoint of [
    "https://user:pass@storage.example.com",
    "https://storage.example.com?token=secret",
    "https://storage.example.com#fragment",
  ]) {
    assert.throws(() => getHostingBackupConfig({
      D_HOSTING_BACKUP_ENDPOINT: endpoint,
      D_HOSTING_BACKUP_BUCKET: "private-bucket",
      D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
      D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
    } as NodeJS.ProcessEnv), /must not contain credentials/);
  }
});

test("rejects invalid bucket names and production loopback endpoints", () => {
  assert.throws(() => getHostingBackupConfig({
    D_HOSTING_BACKUP_ENDPOINT: "https://storage.example.com",
    D_HOSTING_BACKUP_BUCKET: "Invalid_Bucket",
    D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
    D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
  } as NodeJS.ProcessEnv), /bucket is invalid/);

  assert.throws(() => getHostingBackupConfig({
    NODE_ENV: "production",
    D_HOSTING_BACKUP_ENDPOINT: "https://127.0.0.1:9000",
    D_HOSTING_BACKUP_BUCKET: "private-bucket",
    D_HOSTING_BACKUP_ACCESS_KEY_ID: "access",
    D_HOSTING_BACKUP_SECRET_ACCESS_KEY: "secret",
  } as NodeJS.ProcessEnv), /must not contain credentials/);
});


import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { runHostingBackupRetention } from "./platform-backup-worker.js";

test("hosting retention removes only expired objects under its own prefix", async () => {
  const deleted: string[] = [];
  const updates: string[] = [];
  const storage = {
    send: async (command: unknown) => {
      assert.ok(command instanceof DeleteObjectCommand);
      deleted.push((command as DeleteObjectCommand).input.Key ?? "");
      return {};
    },
    destroy: () => undefined,
  } as unknown as S3Client;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, object_key FROM hosting_platform_backups")) {
        return { rows: [
          { id: "expired-1", object_key: "dsquare-d-hosting/platform/expired.dump" },
          { id: "foreign-1", object_key: "another-product/platform/foreign.dump" },
        ], rowCount: 2 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as never;
  const previous = [
    process.env.D_HOSTING_BACKUP_ENDPOINT,
    process.env.D_HOSTING_BACKUP_BUCKET,
    process.env.D_HOSTING_BACKUP_ACCESS_KEY_ID,
    process.env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY,
    process.env.D_HOSTING_BACKUP_PREFIX,
  ];
  process.env.D_HOSTING_BACKUP_ENDPOINT = "https://storage.example.test";
  process.env.D_HOSTING_BACKUP_BUCKET = "private-bucket";
  process.env.D_HOSTING_BACKUP_ACCESS_KEY_ID = "access";
  process.env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY = "secret";
  process.env.D_HOSTING_BACKUP_PREFIX = "dsquare-d-hosting/platform";
  try {
    const removed = await runHostingBackupRetention(pool, storage);
    assert.equal(removed, 1);
    assert.deepEqual(deleted, ["dsquare-d-hosting/platform/expired.dump"]);
    assert.equal(updates.length, 1);
    assert.match(updates[0], /status='expired'/);
    assert.doesNotMatch(updates[0], /object_key\s*=\s*NULL/i);
  } finally {
    [
      "D_HOSTING_BACKUP_ENDPOINT",
      "D_HOSTING_BACKUP_BUCKET",
      "D_HOSTING_BACKUP_ACCESS_KEY_ID",
      "D_HOSTING_BACKUP_SECRET_ACCESS_KEY",
      "D_HOSTING_BACKUP_PREFIX",
    ].forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("hosting retention preserves completed metadata when storage deletion fails", async () => {
  const updates: string[] = [];
  const storage = {
    send: async () => { throw new Error("simulated storage outage"); },
    destroy: () => undefined,
  } as unknown as S3Client;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, object_key FROM hosting_platform_backups")) {
        return { rows: [{ id: "expired-2", object_key: "dsquare-d-hosting/platform/expired.dump" }], rowCount: 1 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as never;
  const previous = [
    process.env.D_HOSTING_BACKUP_ENDPOINT,
    process.env.D_HOSTING_BACKUP_BUCKET,
    process.env.D_HOSTING_BACKUP_ACCESS_KEY_ID,
    process.env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY,
    process.env.D_HOSTING_BACKUP_PREFIX,
  ];
  process.env.D_HOSTING_BACKUP_ENDPOINT = "https://storage.example.test";
  process.env.D_HOSTING_BACKUP_BUCKET = "private-bucket";
  process.env.D_HOSTING_BACKUP_ACCESS_KEY_ID = "access";
  process.env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY = "secret";
  process.env.D_HOSTING_BACKUP_PREFIX = "dsquare-d-hosting/platform";
  try {
    const removed = await runHostingBackupRetention(pool, storage);
    assert.equal(removed, 0);
    assert.equal(updates.length, 0);
  } finally {
    [
      "D_HOSTING_BACKUP_ENDPOINT",
      "D_HOSTING_BACKUP_BUCKET",
      "D_HOSTING_BACKUP_ACCESS_KEY_ID",
      "D_HOSTING_BACKUP_SECRET_ACCESS_KEY",
      "D_HOSTING_BACKUP_PREFIX",
    ].forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
