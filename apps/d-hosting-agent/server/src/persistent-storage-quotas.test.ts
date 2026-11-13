import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceXfsProjectQuota, persistentStorageProjectId } from "./persistent-storage-quotas.js";

const resourceId = "11111111-1111-4111-8111-111111111111";

test("creates deterministic positive XFS project ID candidates", () => {
  const first = persistentStorageProjectId(resourceId);
  assert.equal(first, persistentStorageProjectId(resourceId));
  assert.ok(first > 0 && first <= 2_000_000_000);
  assert.notEqual(first, persistentStorageProjectId("22222222-2222-4222-8222-222222222222"));
});

test("invokes only the configured privileged quota helper with validated numeric arguments", async () => {
  const commands: Array<{ file: string; args: string[] }> = [];
  await enforceXfsProjectQuota({
    storageRoot: "/var/lib/dsquare-hosting-agent/persistent-sites",
    resourceId,
    projectId: 12345,
    hardLimitBytes: 64 * 1024 * 1024,
    helperPath: "/usr/local/sbin/dsquare-xfs-project-quota",
    run: async (file, args) => { commands.push({ file, args }); return { stdout: "" }; },
  });
  assert.deepEqual(commands, [{
    file: "sudo",
    args: ["-n", "--", "/usr/local/sbin/dsquare-xfs-project-quota", resourceId, "12345", String(64 * 1024 * 1024)],
  }]);
});

test("rejects invalid quota IDs, limits and helper paths before invoking commands", async () => {
  const run = async () => { assert.fail("must not run"); return { stdout: "" }; };
  await assert.rejects(enforceXfsProjectQuota({ storageRoot: "/tmp", resourceId: "bad", projectId: 1,
    hardLimitBytes: 64 * 1024 * 1024, run }));
  await assert.rejects(enforceXfsProjectQuota({ storageRoot: "/tmp", resourceId, projectId: 1,
    hardLimitBytes: 1, run }));
  await assert.rejects(enforceXfsProjectQuota({ storageRoot: "/tmp", resourceId, projectId: 1,
    hardLimitBytes: 64 * 1024 * 1024, helperPath: "relative-helper", run }));
});
