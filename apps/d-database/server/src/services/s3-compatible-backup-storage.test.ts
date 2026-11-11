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
