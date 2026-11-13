import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensurePersistentStorageDirectory } from "./persistent-storage.js";

const resourceA = "11111111-1111-4111-8111-111111111111";
const resourceB = "22222222-2222-4222-8222-222222222222";

test("creates stable private directories isolated by website resource", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-persistent-storage-"));
  try {
    const first = await ensurePersistentStorageDirectory(root, resourceA);
    const second = await ensurePersistentStorageDirectory(root, resourceA);
    const other = await ensurePersistentStorageDirectory(root, resourceB);
    assert.equal(first, second, "redeployments for one resource reuse the same directory");
    assert.notEqual(first, other, "different websites never share a directory");
    assert.equal((await lstat(first)).isDirectory(), true);
    assert.equal(await realpath(first), first);
    if (process.platform !== "win32") assert.equal((await lstat(first)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a resource directory that is a symbolic link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-persistent-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "dsquare-persistent-outside-"));
  try {
    await symlink(outside, path.join(root, resourceA), "dir");
    await assert.rejects(ensurePersistentStorageDirectory(root, resourceA), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects invalid IDs and unsafe roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsquare-persistent-invalid-"));
  try {
    await assert.rejects(ensurePersistentStorageDirectory(root, "../other"), /resource ID/);
    await assert.rejects(ensurePersistentStorageDirectory(root + ":unsafe", resourceA), /absolute Linux path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
