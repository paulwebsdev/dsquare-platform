import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_NODE_RUNTIME_FILES,
  MAX_NODE_RUNTIME_FILE_BYTES,
  MAX_NODE_RUNTIME_TOTAL_BYTES,
} from "./node-runtime-artifact.js";
import { normalizeWebsiteFilePath, normalizeWebsiteRequestPath } from "./website-file-path.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type RuntimeArtifactManifestEntry = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type RuntimeArtifactManifest = {
  sha256: string;
  fileCount: number;
  totalBytes: number;
  files: RuntimeArtifactManifestEntry[];
};

/**
 * Builds a deterministic integrity manifest for a staged runtime directory.
 * The digest covers sorted relative paths, file sizes and per-file SHA-256
 * hashes. It is a manifest digest, not a compressed archive digest.
 */
export async function buildRuntimeArtifactManifest(
  artifactDirectory: string,
): Promise<RuntimeArtifactManifest> {
  const root = path.resolve(artifactDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Runtime artifact root must be a real directory.");
  }

  const entries: RuntimeArtifactManifestEntry[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.resolve(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Runtime artifacts must not contain symbolic links.");
      }
      if (metadata.isDirectory()) {
        const safeDirectoryPath = normalizeWebsiteRequestPath(relativePath);
        if (!safeDirectoryPath || safeDirectoryPath !== relativePath) {
          throw new Error("Runtime artifact contains an unsafe directory path.");
        }
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Runtime artifacts may contain only regular files and directories.");
      }
      const safePath = normalizeWebsiteFilePath(relativePath);
      if (!safePath || safePath !== relativePath) {
        throw new Error("Runtime artifact contains an unsafe file path.");
      }
      if (metadata.size > MAX_NODE_RUNTIME_FILE_BYTES) {
        throw new Error("Runtime artifact contains a file larger than 10 MB.");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_NODE_RUNTIME_TOTAL_BYTES) {
        throw new Error("Runtime artifact exceeds the 100 MB total limit.");
      }
      entries.push({
        path: safePath,
        sizeBytes: metadata.size,
        sha256: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
      });
      if (entries.length > MAX_NODE_RUNTIME_FILES) {
        throw new Error("Runtime artifact exceeds the 2,000 file limit.");
      }
    }
  }

  await visit(root);
  if (entries.length === 0) {
    throw new Error("Runtime artifact must contain at least one file.");
  }

  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const canonicalManifest = JSON.stringify(entries);
  const sha256 = createHash("sha256").update(canonicalManifest).digest("hex");
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Runtime artifact manifest digest could not be generated.");
  }

  return { sha256, fileCount: entries.length, totalBytes, files: entries };
}
