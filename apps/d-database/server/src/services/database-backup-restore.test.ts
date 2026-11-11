import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyDatabaseBackupPayload } from "./database-backup-restore.js";

const payload = Buffer.from("verified PostgreSQL backup payload");
const checksum = createHash("sha256").update(payload).digest("hex");

test("accepts a backup payload with the expected size and SHA-256 checksum", () => {
  assert.equal(verifyDatabaseBackupPayload(payload, checksum, payload.length), true);
});

test("rejects a backup payload with a mismatched checksum", () => {
  assert.equal(verifyDatabaseBackupPayload(payload, "0".repeat(64), payload.length), false);
});

test("rejects a backup payload with a mismatched size", () => {
  assert.equal(verifyDatabaseBackupPayload(payload, checksum, payload.length + 1), false);
});

test("rejects empty, oversized, and malformed backup metadata", () => {
  assert.equal(verifyDatabaseBackupPayload(Buffer.alloc(0), checksum, 0), false);
  assert.equal(verifyDatabaseBackupPayload(payload, "invalid", payload.length), false);
  assert.equal(verifyDatabaseBackupPayload(payload, checksum, 256 * 1024 * 1024 + 1), false);
});
