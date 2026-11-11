import { constants } from "node:fs";
import { lstat, mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeWebsiteFilePath } from "./website-file-path.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_NODE_RUNTIME_FILES = 2_000;
export const MAX_NODE_RUNTIME_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_NODE_RUNTIME_TOTAL_BYTES = 100 * 1024 * 1024;

export type NodeRuntimeSourceFile = {
  originalName: string;
  storageKey: string;
};

/**
 * Copies a validated Node project into a fresh, deployment-specific directory.
 * It preserves safe website-relative paths and never executes or installs files.
 * Explicit count and byte limits prevent oversized uploads exhausting the host
 * while the deployment is being staged for a future isolated runtime provider.
 */
export async function prepareNodeRuntimeArtifact(input: {
  resourceId: string;
  deploymentId: string;
  storageRoot: string;
  files: NodeRuntimeSourceFile[];
}): Promise<{ directory: string; fileCount: number; totalBytes: number }> {
  if (!UUID_PATTERN.test(input.resourceId) || !UUID_PATTERN.test(input.deploymentId)) {
    throw new Error("Valid website and deployment IDs are required.");
  }
  if (!input.files.length) {
    throw new Error("A Node.js deployment must contain project files.");
  }
  if (input.files.length > MAX_NODE_RUNTIME_FILES) {
    throw new Error("A Node.js deployment exceeds the maximum of 2,000 files.");
  }

  const names = new Set<string>();
  const validated = input.files.map((file) => {
    const safeName = normalizeWebsiteFilePath(file.originalName);
    if (!safeName || !UUID_PATTERN.test(file.storageKey)) {
      throw new Error("A deployment contains an unsafe file path or storage key.");
    }
    if (names.has(safeName)) {
      throw new Error("A deployment contains duplicate file paths.");
    }
    names.add(safeName);
    return { name: safeName, key: file.storageKey };
  });

  const resourceDirectory = path.resolve(input.storageRoot, input.resourceId);
  const sourceRoot = path.resolve(resourceDirectory);
  const artifactParent = path.resolve(resourceDirectory, "runtime-artifacts");
  const destination = path.resolve(artifactParent, input.deploymentId);
  if (!destination.startsWith(artifactParent + path.sep)) {
    throw new Error("Invalid runtime artifact destination.");
  }

  await mkdir(artifactParent, { recursive: true });
  await mkdir(destination, { recursive: false });

  let totalBytes = 0;
  try {
    for (const file of validated) {
      const source = path.resolve(sourceRoot, file.key);
      const sourceRelative = path.relative(sourceRoot, source);
      const target = path.resolve(destination, file.name);
      const targetRelative = path.relative(destination, target);

      if (
        sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative) ||
        targetRelative.startsWith("..") || path.isAbsolute(targetRelative)
      ) {
        throw new Error("A deployment file resolved outside its permitted directory.");
      }

      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("A deployment source must be a regular stored file.");
      }
      if (metadata.size > MAX_NODE_RUNTIME_FILE_BYTES) {
        throw new Error("A Node.js deployment contains a file larger than 10 MB.");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_NODE_RUNTIME_TOTAL_BYTES) {
        throw new Error("A Node.js deployment exceeds the 100 MB total artifact limit.");
      }

      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }

    return { directory: destination, fileCount: validated.length, totalBytes };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
