import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";

const MAGIC = Buffer.from("DSQBAK01", "ascii");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_BYTES = 600 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

type BackupFile = { path: string; size: number; sha256: string; mode: number; data: string };
type BackupPayload = { version: 1; resourceId: string; createdAt: string; files: BackupFile[]; totalBytes: number };

export type PersistentBackup = {
  backupId: string;
  resourceId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

function inside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Persistent storage path escaped its root.");
}
function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") ||
      value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
async function privateDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || /[\r\n\0:,]/.test(directory)) throw new Error("Storage path must be a safe absolute Linux path.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Storage path must be a real directory.");
  const canonical = await realpath(directory);
  if (canonical !== path.resolve(directory)) throw new Error("Storage path must not traverse symbolic-link parents.");
  await chmod(directory, 0o700);
  return directory;
}
function encryptionKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.byteLength !== 32) throw new Error("Persistent backup encryption key must contain exactly 32 bytes.");
  return key;
}
async function collectFiles(root: string): Promise<{ files: BackupFile[]; totalBytes: number }> {
  const files: BackupFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (!safeRelative(relative)) throw new Error("Persistent storage contains an unsafe path.");
      const target = path.join(directory, entry.name);
      inside(root, target);
      const details = await lstat(target);
      if (details.isSymbolicLink()) throw new Error("Persistent storage backups do not accept symbolic links.");
      if (details.isDirectory()) { await walk(target, relative); continue; }
      if (!details.isFile() || details.size > MAX_FILE_BYTES) throw new Error("Persistent storage contains an unsupported or oversized file.");
      totalBytes += details.size;
      if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new Error("Persistent storage exceeds backup limits.");
      const handle = await open(target, "r");
      try {
        const current = await handle.stat();
        if (current.dev !== details.dev || current.ino !== details.ino || current.size !== details.size) {
          throw new Error("Persistent storage changed while the backup was being created.");
        }
        const bytes = await handle.readFile();
        files.push({ path: relative, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
          mode: details.mode & 0o777, data: bytes.toString("base64") });
      } finally { await handle.close(); }
    }
  };
  await walk(root, "");
  return { files, totalBytes };
}

/** Creates an authenticated, compressed, encrypted snapshot without following symlinks. */
export async function createPersistentStorageBackup(
  storageRoot: string, backupRoot: string, resourceId: string, keyBytes: Uint8Array,
): Promise<PersistentBackup> {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  const key = encryptionKey(keyBytes);
  const sourceRoot = await privateDirectory(storageRoot);
  const source = path.join(sourceRoot, resourceId);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Persistent website directory is invalid.");
  const targetRoot = await privateDirectory(backupRoot);
  const { files, totalBytes } = await collectFiles(source);
  const createdAt = new Date().toISOString();
  const backupId = randomBytes(16).toString("hex");
  const payload: BackupPayload = { version: 1, resourceId, createdAt, files, totalBytes };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(resourceId)]));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([MAGIC, nonce, tag, ciphertext]);
  if (envelope.byteLength > MAX_BACKUP_BYTES) throw new Error("Encrypted persistent backup exceeds the permitted size.");
  const filename = `${resourceId}.${createdAt.replace(/[:.]/g, "-")}.${backupId}.dsqbak`;
  const destination = path.join(targetRoot, filename);
  inside(targetRoot, destination);
  const temporary = path.join(targetRoot, `.tmp-${backupId}`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(envelope); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, destination); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return { backupId, resourceId, path: destination, sizeBytes: envelope.byteLength,
    sha256: createHash("sha256").update(envelope).digest("hex"), createdAt };
}

/** Authenticates and validates a backup before atomically replacing a website's data directory. */
export async function restorePersistentStorageBackup(
  storageRoot: string, backupPath: string, resourceId: string, keyBytes: Uint8Array,
  afterRestore?: () => Promise<void>,
): Promise<{ restoredFiles: number; restoredBytes: number }> {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  const key = encryptionKey(keyBytes);
  const root = await privateDirectory(storageRoot);
  const backup = path.resolve(backupPath);
  const backupStat = await lstat(backup);
  if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.size < 36 || backupStat.size > MAX_BACKUP_BYTES) {
    throw new Error("Persistent backup file is invalid.");
  }
  const envelope = await import("node:fs/promises").then(({ readFile }) => readFile(backup));
  if (!envelope.subarray(0, 8).equals(MAGIC)) throw new Error("Persistent backup format is invalid.");
  const nonce = envelope.subarray(8, 20), tag = envelope.subarray(20, 36), ciphertext = envelope.subarray(36);
  let decoded: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(resourceId)]));
    decipher.setAuthTag(tag);
    decoded = gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()]), { maxOutputLength: MAX_TOTAL_BYTES * 3 });
  } catch { throw new Error("Persistent backup authentication or decompression failed."); }
  let payload: unknown;
  try { payload = JSON.parse(decoded.toString("utf8")); } catch { throw new Error("Persistent backup manifest is invalid."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Persistent backup manifest is invalid.");
  const record = payload as Record<string, unknown>;
  if (record.version !== 1 || record.resourceId !== resourceId || !Array.isArray(record.files) ||
      record.files.length > MAX_FILES || !Number.isSafeInteger(record.totalBytes) ||
      (record.totalBytes as number) < 0 || (record.totalBytes as number) > MAX_TOTAL_BYTES) {
    throw new Error("Persistent backup does not match the requested website.");
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const item of record.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Persistent backup file entry is invalid.");
    const file = item as Record<string, unknown>;
    if (!safeRelative(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) ||
        (file.size as number) < 0 || (file.size as number) > MAX_FILE_BYTES ||
        !SHA256.test(String(file.sha256)) || typeof file.data !== "string" ||
        !Number.isInteger(file.mode) || ((file.mode as number) & ~0o777) !== 0) {
      throw new Error("Persistent backup file entry is invalid.");
    }
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("Persistent backup file integrity check failed.");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Persistent backup exceeds restore limits.");
    seen.add(file.path);
  }
  if (totalBytes !== record.totalBytes) throw new Error("Persistent backup size does not match its manifest.");

  const destination = path.join(root, resourceId);
  const temporary = path.join(root, `.restore-${resourceId}-${randomBytes(8).toString("hex")}`);
  const previous = path.join(root, `.rollback-${resourceId}-${randomBytes(8).toString("hex")}`);
  inside(root, destination); inside(root, temporary); inside(root, previous);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const item of record.files as BackupFile[]) {
      const target = path.resolve(temporary, ...item.path.split("/"));
      inside(temporary, target);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(item.data, "base64");
      await writeFile(target, bytes, { flag: "wx", mode: item.mode & 0o666 });
    }
    let movedOld = false;
    try {
      try {
        const existing = await lstat(destination);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing persistent storage path is unsafe.");
        await rename(destination, previous); movedOld = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(temporary, destination);
      // Reapply filesystem metadata (notably XFS project-quota inheritance)
      // before discarding the previous directory. If enforcement fails,
      // remove the restored tree and put the original directory back.
      try {
        await afterRestore?.();
      } catch (error) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined);
        if (movedOld) await rename(previous, destination).catch(() => undefined);
        throw error;
      }
      if (movedOld) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if (movedOld) {
        const previousStillExists = await lstat(previous).then(() => true).catch(() => false);
        const destinationExists = await lstat(destination).then(() => true).catch(() => false);
        if (previousStillExists && !destinationExists) await rename(previous, destination).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { restoredFiles: seen.size, restoredBytes: totalBytes };
}

/** Returns safe on-disk usage for display/accounting; it is not a hard write quota. */
export async function measurePersistentStorageUsage(storageRoot: string, resourceId: string): Promise<number> {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  const root = await privateDirectory(storageRoot);
  const target = path.join(root, resourceId);
  const details = await lstat(target);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Persistent website directory is invalid.");
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name); inside(target, filePath);
      const item = await lstat(filePath);
      if (item.isSymbolicLink()) throw new Error("Persistent storage contains a symbolic link.");
      if (item.isDirectory()) await walk(filePath);
      else if (item.isFile()) { total += item.size; if (total > Number.MAX_SAFE_INTEGER) throw new Error("Persistent storage usage overflow."); }
      else throw new Error("Persistent storage contains an unsupported filesystem entry.");
    }
  };
  await walk(target);
  return total;
}

/** Moves deleted website data to a private tombstone; it is never immediately destroyed. */
export async function tombstonePersistentStorage(storageRoot: string, resourceId: string): Promise<string | null> {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  const root = await privateDirectory(storageRoot);
  const source = path.join(root, resourceId);
  const details = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Persistent website directory is invalid.");
  const tombstone = path.join(root, `.deleted-${resourceId}-${Date.now()}-${randomBytes(6).toString("hex")}`);
  inside(root, tombstone);
  await rename(source, tombstone);
  return tombstone;
}

/** Removes only old regular backup files; callers must run this after retention policy approval. */
export async function prunePersistentBackups(
  backupRoot: string, resourceId: string, retentionDays: number, now = Date.now(),
): Promise<number> {
  if (!UUID.test(resourceId) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("Persistent backup retention settings are invalid.");
  }
  const root = await privateDirectory(backupRoot);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!name.startsWith(resourceId + ".") || !name.endsWith(".dsqbak")) continue;
    const target = path.join(root, name); inside(root, target);
    const details = await lstat(target);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Backup directory contains an unsafe entry.");
    if (details.mtimeMs < cutoff) { await rm(target, { force: false }); removed += 1; }
  }
  return removed;
}
