import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAGIC = Buffer.from("DSQART01", "ascii");
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

type ManifestFile = { path: string; sizeBytes: number; sha256: string };
type BundleManifest = {
  version: 1;
  artifactId: string;
  manifest: {
    sha256: string;
    fileCount: number;
    totalBytes: number;
    files: ManifestFile[];
  };
};

export type StoredArtifact = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return false;
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((part) => part.length > 0 && part !== "." && part !== ".." &&
    !part.startsWith(".dsquare-agent-"));
}

function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Artifact path escaped its storage directory.");
  }
}

async function ensurePrivateRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Runtime artifact storage root must be a real directory.");
  }
  return absolute;
}

/**
 * Validates and stores the DSQART01 bundle without executing or extracting
 * archives. Every file is written exclusively inside a fresh private folder.
 */
export async function storeRuntimeArtifact(
  storageRoot: string,
  artifactId: string,
  bytes: Uint8Array,
): Promise<StoredArtifact> {
  if (!UUID.test(artifactId)) throw new Error("Runtime artifact ID is invalid.");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 13 || bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error("Runtime artifact bundle size is outside the permitted range.");
  }
  const bundle = Buffer.from(bytes);
  if (!bundle.subarray(0, 8).equals(MAGIC)) throw new Error("Runtime artifact bundle format is invalid.");
  const manifestLength = bundle.readUInt32BE(8);
  if (manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES || 12 + manifestLength > bundle.length) {
    throw new Error("Runtime artifact manifest length is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(bundle.subarray(12, 12 + manifestLength).toString("utf8"));
  } catch {
    throw new Error("Runtime artifact manifest is not valid JSON.");
  }
  if (!isRecord(decoded) || decoded.version !== 1 || decoded.artifactId !== artifactId ||
      !isRecord(decoded.manifest)) {
    throw new Error("Runtime artifact manifest does not match its upload.");
  }
  const manifest = decoded.manifest;
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES ||
      !Number.isSafeInteger(manifest.totalBytes) || (manifest.totalBytes as number) < 1 ||
      (manifest.totalBytes as number) > MAX_TOTAL_FILE_BYTES ||
      manifest.fileCount !== manifest.files.length || !SHA256.test(String(manifest.sha256))) {
    throw new Error("Runtime artifact manifest metadata is invalid.");
  }

  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!isRecord(entry) || !safeArtifactPath(entry.path) ||
        !Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0 ||
        (entry.sizeBytes as number) > MAX_FILE_BYTES || !SHA256.test(String(entry.sha256))) {
      throw new Error("Runtime artifact contains an invalid file entry.");
    }
    const filePath = entry.path as string;
    if (seen.has(filePath)) throw new Error("Runtime artifact contains duplicate file paths.");
    seen.add(filePath);
    files.push({ path: filePath, sizeBytes: entry.sizeBytes as number, sha256: entry.sha256 as string });
    totalBytes += entry.sizeBytes as number;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new Error("Runtime artifact exceeds the total file limit.");
  }
  if (totalBytes !== manifest.totalBytes) throw new Error("Runtime artifact total size does not match its manifest.");
  const canonical = JSON.stringify(files);
  const manifestDigest = createHash("sha256").update(canonical).digest("hex");
  if (manifestDigest !== manifest.sha256) throw new Error("Runtime artifact manifest digest is invalid.");

  let offset = 12 + manifestLength;
  const payloads: Buffer[] = [];
  for (const file of files) {
    const end = offset + file.sizeBytes;
    if (end > bundle.length) throw new Error("Runtime artifact file data is truncated.");
    const payload = bundle.subarray(offset, end);
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== file.sha256) throw new Error("Runtime artifact file digest is invalid.");
    payloads.push(payload);
    offset = end;
  }
  if (offset !== bundle.length) throw new Error("Runtime artifact contains unexpected trailing bytes.");

  const root = await ensurePrivateRoot(storageRoot);
  const finalDirectory = path.join(root, artifactId);
  const metadataPath = path.join(root, `${artifactId}.metadata.json`);
  const temporaryDirectory = path.join(root, `.dsquare-agent-${artifactId}-${process.pid}-${Date.now()}`);
  const temporaryMetadata = path.join(root, `.dsquare-agent-${artifactId}-${process.pid}.metadata.tmp`);
  ensureInside(root, finalDirectory);
  try {
    await mkdir(temporaryDirectory, { mode: 0o700 });
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const target = path.resolve(temporaryDirectory, ...file.path.split("/"));
      ensureInside(temporaryDirectory, target);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(payloads[index]!);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    const descriptor: StoredArtifact = {
      artifactId,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      sizeBytes: bundle.byteLength,
      fileCount: files.length,
    };
    await writeFile(temporaryMetadata, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
    await rename(temporaryDirectory, finalDirectory);
    try {
      await rename(temporaryMetadata, metadataPath);
    } catch (error) {
      await rm(finalDirectory, { recursive: true, force: true });
      throw error;
    }
    return descriptor;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(temporaryMetadata, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readStoredArtifact(
  storageRoot: string,
  artifactId: string,
): Promise<StoredArtifact | null> {
  if (!UUID.test(artifactId)) return null;
  const root = await ensurePrivateRoot(storageRoot);
  const metadataPath = path.join(root, `${artifactId}.metadata.json`);
  ensureInside(root, metadataPath);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    if (!isRecord(metadata) || metadata.artifactId !== artifactId ||
        !SHA256.test(String(metadata.sha256)) ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        !Number.isInteger(metadata.fileCount)) return null;
    return metadata as StoredArtifact;
  } catch {
    return null;
  }
}

export async function deleteStoredArtifact(storageRoot: string, artifactId: string): Promise<boolean> {
  if (!UUID.test(artifactId)) return false;
  const root = await ensurePrivateRoot(storageRoot);
  const artifactDirectory = path.join(root, artifactId);
  const metadataPath = path.join(root, `${artifactId}.metadata.json`);
  ensureInside(root, artifactDirectory);
  ensureInside(root, metadataPath);
  const metadata = await readStoredArtifact(root, artifactId);
  if (!metadata) return false;
  await rm(artifactDirectory, { recursive: true, force: false });
  await rm(metadataPath, { force: false });
  return true;
}
