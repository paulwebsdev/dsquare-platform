import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
import { createPersistentStorageBackup, prunePersistentBackups, type PersistentBackup } from "./persistent-storage-backups.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodePersistentBackupKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("RUNTIME_AGENT_BACKUP_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

export type BackupCycleResult = { resources: number; created: number; pruned: number; failed: number };

/** One bounded, non-overlapping backup/retention pass. */
export async function runPersistentBackupCycle(input: {
  storageRoot: string; backupRoot: string; key: Uint8Array; retentionDays: number;
  now?: number; onError?: (resourceId: string, error: unknown) => void;
  onBackup?: (backup: PersistentBackup) => Promise<void>; onResourceComplete?: (resourceId: string) => Promise<void>;
}): Promise<BackupCycleResult> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) throw new Error("Persistent backup retention must be between 1 and 3650 days.");
  const entries = await readdir(input.storageRoot, { withFileTypes: true });
  const resources = entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name) && !entry.isSymbolicLink());
  const result: BackupCycleResult = { resources: resources.length, created: 0, pruned: 0, failed: 0 };
  for (const entry of resources) {
    try {
      const backup = await createPersistentStorageBackup(input.storageRoot, input.backupRoot, entry.name, input.key);
      await input.onBackup?.(backup);
      result.created += 1;
      result.pruned += await prunePersistentBackups(input.backupRoot, entry.name, input.retentionDays, input.now);
      await input.onResourceComplete?.(entry.name);
    } catch (error) {
      result.failed += 1;
      input.onError?.(entry.name, error);
    }
  }
  return result;
}

/** Starts a single-flight timer. The first run is delayed to avoid startup I/O spikes. */
export function startPersistentBackupScheduler(input: {
  storageRoot: string; backupRoot: string; key: Uint8Array; retentionDays: number;
  intervalMs: number; onError?: (resourceId: string, error: unknown) => void;
  onBackup?: (backup: PersistentBackup) => Promise<void>; onResourceComplete?: (resourceId: string) => Promise<void>;
  onCycle?: (result: BackupCycleResult) => void;
}): () => void {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) throw new Error("Persistent backup retention must be between 1 and 3650 days.");
  const storageRoot = path.resolve(input.storageRoot);
  const backupRoot = path.resolve(input.backupRoot);
  const relativeBackup = path.relative(storageRoot, backupRoot);
  const relativeStorage = path.relative(backupRoot, storageRoot);
  if (!relativeBackup || (!relativeBackup.startsWith("..") && !path.isAbsolute(relativeBackup)) || !relativeStorage.startsWith("..")) {
    throw new Error("Persistent backups must use a separate directory outside the website storage root.");
  }
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 7 * 86400_000) {
    throw new Error("Persistent backup interval must be between one minute and seven days.");
  }
  let running = false;
  let stopped = false;
  let activeRun: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    activeRun = runPersistentBackupCycle(input)
      .then((result) => input.onCycle?.(result))
      .catch((error) => console.error("Persistent backup cycle failed:", error instanceof Error ? error.message : "Unknown error"))
      .finally(() => { running = false; activeRun = undefined; });
  }, input.intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeRun;
  };
}

export function resolveBackupDirectory(value: string): string {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error("Persistent backup directory must be a safe absolute path.");
  return path.resolve(value);
}

/**
 * Fails closed unless backups are stored on a network filesystem distinct
 * from the live persistent-storage filesystem. A local sibling directory is
 * not an off-host backup and must never be accepted as the production target.
 */
export async function verifyOffHostBackupMount(input: {
  storageRoot: string; backupRoot: string;
  run?: (file: string, args: string[]) => Promise<{ stdout: string }>;
}): Promise<void> {
  const storageRoot = path.resolve(input.storageRoot);
  const backupRoot = path.resolve(input.backupRoot);
  const relative = path.relative(storageRoot, backupRoot);
  const reverse = path.relative(backupRoot, storageRoot);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
      !reverse.startsWith("..")) {
    throw new Error("Backup destination must be outside the live storage root.");
  }
  const run = input.run ?? (async (file, args) => {
    const result = await execFileAsync(file, args, { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
    return { stdout: result.stdout };
  });
  const [storage, backup] = await Promise.all([
    run("findmnt", ["-n", "-o", "FSTYPE,SOURCE", "-T", storageRoot]),
    run("findmnt", ["-n", "-o", "FSTYPE,SOURCE", "-T", backupRoot]),
  ]);
  const [storageType, storageSource] = storage.stdout.trim().split(/\s+/, 2);
  const [backupType, backupSource] = backup.stdout.trim().split(/\s+/, 2);
  const remoteTypes = new Set(["nfs", "nfs4", "cifs", "smb3"]);
  if (!storageType || !storageSource || !backupType || !backupSource ||
      !remoteTypes.has(backupType) || storageSource === backupSource) {
    throw new Error("Backup destination must be a separate remote NFS or SMB/CIFS filesystem.");
  }
}
