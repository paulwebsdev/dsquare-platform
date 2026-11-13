import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QuotaCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * XFS project-quota adapter. The backing filesystem MUST be mounted with
 * project quotas enabled (prjquota/pquota). Project IDs are allocated and
 * persisted by the caller; they must never be reused while data exists.
 */
export async function enforceXfsProjectQuota(input: {
  storageRoot: string; resourceId: string; projectId: number; hardLimitBytes: number;
  run?: QuotaCommandRunner;
}): Promise<void> {
  if (!UUID.test(input.resourceId) || !Number.isSafeInteger(input.projectId) ||
      input.projectId < 1 || input.projectId > 2_000_000_000 ||
      !Number.isSafeInteger(input.hardLimitBytes) || input.hardLimitBytes < 16 * 1024 * 1024) {
    throw new Error("Persistent storage quota configuration is invalid.");
  }
  const root = path.resolve(input.storageRoot);
  const target = path.join(root, input.resourceId);
  const rootStat = await lstat(root);
  const targetStat = await lstat(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("Persistent storage quota paths must be real directories.");
  }
  const run = input.run ?? (async (file, args) => {
    const result = await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
    return { stdout: result.stdout };
  });
  const filesystem = await run("findmnt", ["-n", "-o", "FSTYPE,OPTIONS", "-T", root]);
  const [filesystemType, mountOptions = ""] = filesystem.stdout.trim().split(/\\s+/, 2);
  if (filesystemType !== "xfs" || !/(^|,)(prjquota|pquota)(,|$)/.test(mountOptions)) {
    throw new Error("Persistent storage must reside on XFS mounted with prjquota or pquota.");
  }
  const mount = await run("findmnt", ["-n", "-o", "TARGET", "-T", root]);
  const mountPoint = mount.stdout.trim();
  if (!mountPoint.startsWith("/") || /[\\r\\n\\0]/.test(mountPoint)) throw new Error("Could not safely resolve the XFS mount point.");
  await run("xfs_io", ["-r", "-c", `chproj -R ${input.projectId}`, target]);
  await run("xfs_io", ["-r", "-c", `chattr +P`, target]);
  const hardBlocks = Math.ceil(input.hardLimitBytes / 1024);
  await run("xfs_quota", ["-x", "-c", `limit -p bhard=${hardBlocks}k ${input.projectId}`, mountPoint]);
}

/** Deterministic candidate only; caller MUST reserve it under a database UNIQUE constraint. */
export function persistentStorageProjectId(resourceId: string): number {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  let hash = 2166136261;
  for (const character of resourceId.toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1_900_000_000 + 1;
}
