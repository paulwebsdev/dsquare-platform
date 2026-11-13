import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enforceXfsProjectQuota, persistentStorageProjectId } from "./persistent-storage-quotas.js";

const resourceId = "11111111-1111-4111-8111-111111111111";

test("creates deterministic positive XFS project ID candidates", () => {
  const first = persistentStorageProjectId(resourceId);
  assert.equal(first, persistentStorageProjectId(resourceId));
  assert.ok(first > 0 && first <= 2_000_000_000);
  assert.notEqual(first, persistentStorageProjectId("22222222-2222-4222-8222-222222222222"));
});

test("applies an XFS hard quota using argument-safe commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-xfs-quota-"));
  const commands: Array<{ file: string; args: string[] }> = [];
  try {
    await mkdir(path.join(root, resourceId));
    await enforceXfsProjectQuota({ storageRoot: root, resourceId, projectId: 12345, hardLimitBytes: 64 * 1024 * 1024,
      run: async (file, args) => { commands.push({ file, args }); } });
    assert.deepEqual(commands.map((item) => item.file), ["xfs_io", "xfs_io", "xfs_quota"]);
    assert.ok(commands[2].args[2].includes("bhard=65536k"));
    assert.ok(commands.every((item) => !item.args.some((arg) => arg.includes(";"))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid quota IDs and unsafe paths before invoking commands", async () => {
  await assert.rejects(enforceXfsProjectQuota({ storageRoot: "/tmp", resourceId: "bad", projectId: 1,
    hardLimitBytes: 64 * 1024 * 1024, run: async () => assert.fail("must not run") }));
});
