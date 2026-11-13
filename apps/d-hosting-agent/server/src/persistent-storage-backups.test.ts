import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPersistentStorageBackup,
  measurePersistentStorageUsage,
  prunePersistentBackups,
  restorePersistentStorageBackup,
  tombstonePersistentStorage,
} from "./persistent-storage-backups.js";

const resourceId = "11111111-1111-4111-8111-111111111111";
const key = Buffer.alloc(32, 7);

test("creates an encrypted backup and restores website files atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-storage-backup-"));
  const storage = path.join(root, "storage");
  const backups = path.join(root, "backups");
  try {
    const website = path.join(storage, resourceId);
    await mkdir(path.join(website, "uploads"), { recursive: true });
    await writeFile(path.join(website, "index.html"), "first version");
    await writeFile(path.join(website, "uploads", "photo.txt"), "durable file");
    const backup = await createPersistentStorageBackup(storage, backups, resourceId, key);
    const encrypted = await readFile(backup.path);
    assert.equal(encrypted.subarray(0, 8).toString("ascii"), "DSQBAK02");
    assert.equal(encrypted.includes(Buffer.from("first version")), false);
    await writeFile(path.join(website, "index.html"), "damaged version");
    await rm(path.join(website, "uploads"), { recursive: true });
    const restored = await restorePersistentStorageBackup(storage, backup.path, resourceId, key);
    assert.equal(restored.restoredFiles, 2);
    assert.equal(await readFile(path.join(website, "index.html"), "utf8"), "first version");
    assert.equal(await readFile(path.join(website, "uploads", "photo.txt"), "utf8"), "durable file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restores backups using the embedded key ID after active-key rotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-storage-key-rotation-"));
  const storage = path.join(root, "storage"), backups = path.join(root, "backups");
  const oldKey = Buffer.alloc(32, 11);
  const newKey = Buffer.alloc(32, 12);
  try {
    const website = path.join(storage, resourceId);
    await mkdir(website, { recursive: true });
    await writeFile(path.join(website, "index.html"), "rotated key content");
    const backup = await createPersistentStorageBackup(storage, backups, resourceId, newKey, "backup-2026-11");
    assert.equal(backup.keyId, "backup-2026-11");
    await writeFile(path.join(website, "index.html"), "changed");
    const restored = await restorePersistentStorageBackup(storage, backup.path, resourceId, (keyId) => {
      assert.equal(keyId, "backup-2026-11");
      return newKey;
    });
    assert.equal(restored.restoredFiles, 1);
    assert.equal(await readFile(path.join(website, "index.html"), "utf8"), "rotated key content");
    await assert.rejects(restorePersistentStorageBackup(storage, backup.path, resourceId, oldKey), /authentication/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects wrong keys and tampered backup data without touching live files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-storage-tamper-"));
  const storage = path.join(root, "storage"), backups = path.join(root, "backups");
  try {
    const website = path.join(storage, resourceId);
    await mkdir(website, { recursive: true });
    await writeFile(path.join(website, "index.html"), "safe");
    const backup = await createPersistentStorageBackup(storage, backups, resourceId, key);
    await assert.rejects(restorePersistentStorageBackup(storage, backup.path, resourceId, Buffer.alloc(32, 8)), /authentication/);
    const bytes = await readFile(backup.path);
    bytes[bytes.length - 1] ^= 1;
    const tampered = path.join(backups, "tampered.dsqbak");
    await writeFile(tampered, bytes);
    await assert.rejects(restorePersistentStorageBackup(storage, tampered, resourceId, key), /authentication/);
    assert.equal(await readFile(path.join(website, "index.html"), "utf8"), "safe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("measures usage and tombstones deleted website data instead of purging it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-storage-tombstone-"));
  const storage = path.join(root, "storage");
  try {
    const website = path.join(storage, resourceId);
    await mkdir(website, { recursive: true });
    await writeFile(path.join(website, "index.html"), "12345");
    assert.equal(await measurePersistentStorageUsage(storage, resourceId), 5);
    const tombstone = await tombstonePersistentStorage(storage, resourceId);
    assert.ok(tombstone);
    await assert.rejects(readFile(path.join(website, "index.html")));
    assert.equal(await readFile(path.join(tombstone!, "index.html"), "utf8"), "12345");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prunes only expired backups belonging to the selected website", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-storage-retention-"));
  try {
    const old = path.join(root, resourceId + ".old.dsqbak");
    const fresh = path.join(root, resourceId + ".fresh.dsqbak");
    const other = path.join(root, "22222222-2222-4222-8222-222222222222.old.dsqbak");
    await Promise.all([writeFile(old, "old"), writeFile(fresh, "fresh"), writeFile(other, "other")]);
    const past = new Date(Date.now() - 40 * 86400_000);
    await utimes(old, past, past);
    assert.equal(await prunePersistentBackups(root, resourceId, 30), 1);
    await assert.rejects(readFile(old));
    assert.equal(await readFile(fresh, "utf8"), "fresh");
    assert.equal(await readFile(other, "utf8"), "other");
  } finally { await rm(root, { recursive: true, force: true }); }
});
