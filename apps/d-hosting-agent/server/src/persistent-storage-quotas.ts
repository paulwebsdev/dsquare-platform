import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HELPER = "/usr/local/sbin/dsquare-xfs-project-quota";

export type QuotaCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * Applies an XFS project hard quota through one narrowly scoped, root-owned
 * helper. The runtime agent itself stays unprivileged; sudoers must permit
 * only this helper. The helper validates the configured storage root again.
 */
export async function enforceXfsProjectQuota(input: {
  storageRoot: string; resourceId: string; projectId: number; hardLimitBytes: number;
  helperPath?: string; run?: QuotaCommandRunner;
}): Promise<void> {
  if (!UUID.test(input.resourceId) || !Number.isSafeInteger(input.projectId) ||
      input.projectId < 1 || input.projectId > 2_000_000_000 ||
      !Number.isSafeInteger(input.hardLimitBytes) || input.hardLimitBytes < 16 * 1024 * 1024) {
    throw new Error("Persistent storage quota configuration is invalid.");
  }
  const root = path.resolve(input.storageRoot);
  const helper = input.helperPath ?? process.env.RUNTIME_AGENT_XFS_QUOTA_HELPER ?? DEFAULT_HELPER;
  if (!path.isAbsolute(helper) || /[\r\n\0]/.test(helper)) {
    throw new Error("XFS quota helper must be a safe absolute path.");
  }
  const run = input.run ?? (async (file, args) => {
    const result = await execFileAsync(file, args, { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    return { stdout: result.stdout };
  });
  // Do not invoke shell parsing. The privileged helper accepts only numeric
  // identifiers and a byte limit, and reads its allowed storage root from a
  // root-owned configuration file.
  await run("sudo", ["-n", "--", helper, input.resourceId, String(input.projectId), String(input.hardLimitBytes)]);
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
