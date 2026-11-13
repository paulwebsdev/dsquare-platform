import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Durable, private per-website storage. It is independent of deployment artifacts. */
export async function ensurePersistentStorageDirectory(root: string, resourceId: string): Promise<string> {
  if (!UUID.test(resourceId)) throw new Error("Persistent storage resource ID is invalid.");
  if (!path.isAbsolute(root) || /[\r\n\0:,]/.test(root)) {
    throw new Error("Persistent storage root must be a safe absolute Linux path.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const directory = path.join(canonicalRoot, resourceId);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Persistent storage directory must be a real directory, not a symbolic link.");
  }
  const canonicalDirectory = await realpath(directory);
  if (path.dirname(canonicalDirectory) !== canonicalRoot || path.basename(canonicalDirectory) !== resourceId) {
    throw new Error("Persistent storage directory escaped its configured root.");
  }
  await chmod(canonicalDirectory, 0o700);
  return canonicalDirectory;
}
