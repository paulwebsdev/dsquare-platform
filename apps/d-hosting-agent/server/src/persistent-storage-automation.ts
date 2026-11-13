import { readdir } from "node:fs/promises";
import path from "node:path";
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
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 7 * 86400_000) {
    throw new Error("Persistent backup interval must be between one minute and seven days.");
  }
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void runPersistentBackupCycle(input)
      .then((result) => input.onCycle?.(result))
      .catch((error) => console.error("Persistent backup cycle failed:", error instanceof Error ? error.message : "Unknown error"))
      .finally(() => { running = false; });
  }, input.intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

export function resolveBackupDirectory(value: string): string {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error("Persistent backup directory must be a safe absolute path.");
  return path.resolve(value);
}
