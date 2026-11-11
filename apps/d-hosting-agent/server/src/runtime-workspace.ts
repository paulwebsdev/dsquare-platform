import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function assertSafeSegment(value: string): void {
  if (!value || value === "." || value === ".." || value.startsWith(".dsquare-agent-") ||
      value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Runtime artifact contains an unsafe path.");
  }
}
function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime workspace path escaped its root.");
  }
}

/**
 * Copies an already validated artifact into a separate read-only workspace.
 * The container mounts this directory at /app; original uploads stay private.
 */
export async function materializeRuntimeWorkspace(
  storageRoot: string,
  artifactId: string,
  runtimeRoot: string,
): Promise<string> {
  if (!UUID.test(artifactId)) throw new Error("Runtime artifact ID is invalid.");
  const sourceRoot = path.resolve(storageRoot);
  const source = path.join(sourceRoot, artifactId);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Stored runtime artifact directory is invalid.");
  }

  const destinationRoot = path.resolve(runtimeRoot);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(destinationRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Runtime workspace root must be a real directory.");
  }
  const finalDirectory = path.join(destinationRoot, artifactId);
  const temporaryDirectory = path.join(
    destinationRoot,
    `.dsquare-runtime-${artifactId}-${process.pid}-${Date.now()}`,
  );
  ensureInside(destinationRoot, finalDirectory);
  ensureInside(destinationRoot, temporaryDirectory);

  let fileCount = 0;
  let totalBytes = 0;
  const chmodDirectories: string[] = [];
  const copyDirectory = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      assertSafeSegment(entry.name);
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      ensureInside(source, sourcePath);
      ensureInside(temporaryDirectory, destinationPath);
      const stat = await lstat(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("Runtime artifacts cannot contain symbolic links.");
      if (stat.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o755 });
        chmodDirectories.push(destinationPath);
        await copyDirectory(sourcePath, destinationPath);
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error("Runtime artifact contains an unsupported or oversized file.");
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Runtime artifact exceeds workspace limits.");
      }

      const sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const destinationHandle = await open(destinationPath, "wx", 0o444);
      try {
        const opened = await sourceHandle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
          throw new Error("Runtime artifact changed while being materialized.");
        }
        const bytes = await sourceHandle.readFile();
        if (bytes.byteLength !== stat.size) throw new Error("Runtime artifact changed while being copied.");
        await destinationHandle.writeFile(bytes);
        await destinationHandle.sync();
      } finally {
        await sourceHandle.close();
        await destinationHandle.close();
      }
      await chmod(destinationPath, 0o444);
    }
  };

  try {
    await mkdir(temporaryDirectory, { mode: 0o755 });
    await copyDirectory(source, temporaryDirectory);
    if (fileCount < 1) throw new Error("Runtime artifact contains no files.");
    for (const directory of chmodDirectories.reverse()) await chmod(directory, 0o555);
    await chmod(temporaryDirectory, 0o555);
    await rename(temporaryDirectory, finalDirectory);
    return finalDirectory;
  } catch (error) {
    await makeDirectoriesWritable(temporaryDirectory).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function makeDirectoriesWritable(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesWritable(path.join(directory, entry.name));
  }
  await chmod(directory, 0o700);
}

/** Removes only a workspace with a valid artifact UUID beneath the configured root. */
export async function removeRuntimeWorkspace(runtimeRoot: string, artifactId: string): Promise<boolean> {
  if (!UUID.test(artifactId)) return false;
  const root = path.resolve(runtimeRoot);
  const target = path.join(root, artifactId);
  ensureInside(root, target);
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    await makeDirectoriesWritable(target);
    await rm(target, { recursive: true, force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
