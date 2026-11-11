import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildRuntimeArtifactManifest } from "./runtime-artifact-manifest.js";
import type { RuntimeArtifactDescriptor } from "./runtime-agent-contract.js";

const MAGIC = Buffer.from("DSQART01", "ascii");
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RuntimeArtifactBundle = {
  artifactId: string;
  bytes: Buffer;
  descriptor: RuntimeArtifactDescriptor;
};

/**
 * Creates a bounded, deterministic binary bundle:
 * magic (8 bytes), manifest length (uint32 BE), JSON manifest, then file
 * contents in manifest order. The manifest records every path, size and hash.
 */
export async function buildRuntimeArtifactBundle(input: {
  artifactId: string;
  artifactDirectory: string;
}): Promise<RuntimeArtifactBundle> {
  if (!UUID_PATTERN.test(input.artifactId)) {
    throw new Error("A valid runtime artifact ID is required.");
  }
  const root = path.resolve(input.artifactDirectory);
  const manifest = await buildRuntimeArtifactManifest(root);
  const manifestBytes = Buffer.from(JSON.stringify({
    version: 1,
    artifactId: input.artifactId,
    manifest,
  }), "utf8");
  if (manifestBytes.byteLength > 1024 * 1024) {
    throw new Error("Runtime artifact manifest exceeds the permitted size.");
  }

  const fileBuffers: Buffer[] = [];
  let actualTotal = MAGIC.byteLength + 4 + manifestBytes.byteLength;
  for (const entry of manifest.files) {
    const absolute = path.resolve(root, ...entry.path.split("/"));
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Runtime artifact file resolved outside its root.");
    }
    const bytes = await readFile(absolute);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.sizeBytes || digest !== entry.sha256) {
      throw new Error("Runtime artifact changed while the bundle was being prepared.");
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_BUNDLE_BYTES) {
      throw new Error("Runtime artifact bundle exceeds the 100 MB upload limit.");
    }
    fileBuffers.push(bytes);
  }

  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.byteLength, 0);
  const bytes = Buffer.concat([MAGIC, header, manifestBytes, ...fileBuffers], actualTotal);
  const descriptor: RuntimeArtifactDescriptor = {
    artifactId: input.artifactId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    fileCount: manifest.fileCount,
  };
  return { artifactId: input.artifactId, bytes, descriptor };
}
