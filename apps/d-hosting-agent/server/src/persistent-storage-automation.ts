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

export type PersistentBackupKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export function decodePersistentBackupKeyring(
  keysJson?: string,
  activeKeyIdValue?: string,
  legacyKeyValue?: string,
): PersistentBackupKeyring | undefined {
  const keys = new Map<string, Buffer>();
  if (legacyKeyValue?.trim()) keys.set("default", decodePersistentBackupKey(legacyKeyValue.trim()));
  if (keysJson?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(keysJson); } catch { throw new Error("RUNTIME_AGENT_BACKUP_KEYS_JSON must contain a valid JSON object."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("RUNTIME_AGENT_BACKUP_KEYS_JSON must contain a key-ID to base64-key object.");
    for (const [keyId, encoded] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(keyId) || typeof encoded !== "string") throw new Error("Persistent backup keyring entry is invalid.");
      keys.set(keyId, decodePersistentBackupKey(encoded));
    }
  }
  if (keys.size === 0) return undefined;
  const activeKeyId = activeKeyIdValue?.trim() || (keys.has("default") ? "default" : "");
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(activeKeyId) || !keys.has(activeKeyId)) {
    throw new Error("RUNTIME_AGENT_BACKUP_ACTIVE_KEY_ID must name a key present in the configured keyring.");
  }
  return { activeKeyId, keys };
}

export function resolvePersistentBackupKey(keyring: PersistentBackupKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error("Persistent backup key ID is not present in the configured keyring.");
  return key;
}

export type BackupCycleResult = { resources: number; created: number; pruned: number; failed: number };

/** One bounded, non-overlapping backup/retention pass. */
export async function runPersistentBackupCycle(input: {
  storageRoot: string; backupRoot: string; key: Uint8Array; keyId?: string; retentionDays: number;
  now?: number; onError?: (resourceId: string, error: unknown) => void;
  onBackup?: (backup: PersistentBackup) => Promise<void>; onResourceComplete?: (resourceId: string) => Promise<void>;
}): Promise<BackupCycleResult> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) throw new Error("Persistent backup retention must be between 1 and 3650 days.");
  const entries = await readdir(input.storageRoot, { withFileTypes: true });
  const resources = entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name) && !entry.isSymbolicLink());
  const result: BackupCycleResult = { resources: resources.length, created: 0, pruned: 0, failed: 0 };
  for (const entry of resources) {
    try {
      const backup = await createPersistentStorageBackup(input.storageRoot, input.backupRoot, entry.name, input.key, input.keyId);
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
  storageRoot: string; backupRoot: string; key: Uint8Array; keyId?: string; retentionDays: number;
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
