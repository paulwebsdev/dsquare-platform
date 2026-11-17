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
