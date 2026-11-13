import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodePersistentBackupKey, runPersistentBackupCycle, verifyOffHostBackupMount } from "./persistent-storage-automation.js";

const resourceId = "11111111-1111-4111-8111-111111111111";

test("accepts only canonical base64 32-byte backup keys", () => {
  const key = Buffer.alloc(32, 4);
  assert.deepEqual(decodePersistentBackupKey(key.toString("base64")), key);
  assert.throws(() => decodePersistentBackupKey("short"), /32-byte/);
});

test("scheduled backup cycle snapshots valid website directories and skips unrelated entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-backup-cycle-"));
  const storageRoot = path.join(root, "storage");
  const backupRoot = path.join(root, "backups");
  try {
    await mkdir(path.join(storageRoot, resourceId), { recursive: true });
    await mkdir(path.join(storageRoot, ".deleted-old"), { recursive: true });
    await writeFile(path.join(storageRoot, resourceId, "index.html"), "scheduled");
    const result = await runPersistentBackupCycle({ storageRoot, backupRoot, key: Buffer.alloc(32, 5), retentionDays: 30 });
    assert.deepEqual(result, { resources: 1, created: 1, pruned: 0, failed: 0 });
    const backups = await (await import("node:fs/promises")).readdir(backupRoot);
    assert.equal(backups.length, 1);
    assert.ok(backups[0].endsWith(".dsqbak"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepts only a separate remote NFS or SMB backup mount", async () => {
  const commands: string[][] = [];
  await verifyOffHostBackupMount({
    storageRoot: "/srv/dsquare/persistent-sites",
    backupRoot: "/mnt/remote/dsquare-backups",
    run: async (_file, args) => {
      commands.push(args);
      return { stdout: args[args.length - 1] === "/srv/dsquare/persistent-sites" ? "xfs /dev/vdb1\\n" : "nfs4 backup01:/exports/dsquare\\n" };
    },
  });
  assert.equal(commands.length, 2);
  await assert.rejects(verifyOffHostBackupMount({
    storageRoot: "/srv/dsquare/persistent-sites",
    backupRoot: "/mnt/local/dsquare-backups",
    run: async (_file, args) => ({ stdout: args[args.length - 1] === "/srv/dsquare/persistent-sites" ? "xfs /dev/vdb1\\n" : "ext4 /dev/vdb1\\n" }),
  }), /separate remote NFS or SMB/);
  await assert.rejects(verifyOffHostBackupMount({
    storageRoot: "/srv/dsquare/persistent-sites",
    backupRoot: "/srv/dsquare/persistent-sites/.backups",
    run: async () => { assert.fail("must reject nested path before mount lookup"); return { stdout: "" }; },
  }), /outside the live storage root/);
});
