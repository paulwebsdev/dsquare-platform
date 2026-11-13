import "dotenv/config";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const APPLY = process.argv.includes("--apply");
const ROOT = path.resolve(process.env.HOSTING_STORAGE_ROOT || path.join(process.cwd(), "storage", "sites"));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required object-storage setting: ${name}`);
  return value;
}

function getStorage() {
  const bucket = required("HOSTING_OBJECT_STORAGE_BUCKET");
  const region = required("HOSTING_OBJECT_STORAGE_REGION");
  const accessKeyId = required("HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = required("HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const endpoint = process.env.HOSTING_OBJECT_STORAGE_ENDPOINT?.trim();
  if (endpoint) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Migration requires a clean HTTPS object-storage endpoint.");
    }
  }
  return {
    bucket,
    client: new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle: Boolean(endpoint),
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function scopedObjectKey(ownerId: string, projectId: string, resourceId: string, objectId: string): string {
  if (![ownerId, projectId, resourceId, objectId].every(value => UUID.test(value))) {
    throw new Error("Cannot migrate an object with invalid owner/project/website/object identity.");
  }
  return `owners/${ownerId}/projects/${projectId}/websites/${resourceId}/${objectId}`;
}

async function findLegacyFile(resourceId: string, storageKey: string, deploymentId?: string): Promise<string | null> {
  if (!UUID.test(resourceId) || !UUID.test(storageKey)) return null;
  const candidates = [
    path.join(ROOT, resourceId, storageKey),
    ...(deploymentId && UUID.test(deploymentId)
      ? [path.join(ROOT, resourceId, "deployments", deploymentId, storageKey)]
      : []),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const allowedRoot = path.resolve(ROOT, resourceId) + path.sep;
    if (!resolved.startsWith(allowedRoot)) continue;
    try {
      const info = await lstat(resolved);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_FILE_BYTES) {
        throw new Error("Legacy object is not a permitted regular file.");
      }
      const actual = await realpath(resolved);
      if (!actual.startsWith(allowedRoot)) throw new Error("Legacy object path escapes its website storage directory.");
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function migrateObject(input: {
  ownerId: string;
  projectId: string;
  resourceId: string;
  oldKey: string;
  expectedSize: number;
  contentType: string;
  deploymentId?: string;
}): Promise<{ newKey: string; oldPath: string; sha256: string } | null> {
  const oldPath = await findLegacyFile(input.resourceId, input.oldKey, input.deploymentId);
  if (!oldPath) return null;
  const bytes = await readFile(oldPath);
  if (bytes.byteLength !== input.expectedSize || bytes.byteLength < 1 || bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`Legacy object size mismatch or limit exceeded: ${input.oldKey}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectId = randomUUID();
  const newKey = scopedObjectKey(input.ownerId, input.projectId, input.resourceId, objectId);
  if (!APPLY) return { newKey, oldPath, sha256 };

  const storage = getStorage();
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: newKey,
    Body: bytes,
    ContentLength: bytes.byteLength,
    ContentType: input.contentType || "application/octet-stream",
    Metadata: {
      owner: input.ownerId,
      project: input.projectId,
      website: input.resourceId,
      sha256,
      migrated: "true",
    },
    ServerSideEncryption: "AES256",
  }));
  const verified = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: newKey }));
  if (Number(verified.ContentLength) !== bytes.byteLength || verified.Metadata?.sha256 !== sha256) {
    throw new Error(`Uploaded object verification failed: ${newKey}`);
  }
  return { newKey, oldPath, sha256 };
}

async function main() {
  if (process.env.NODE_ENV === "production" && !APPLY) {
    console.log("Production dry-run only. Add --apply to perform migration.");
  }
  const client = await pool.connect();
  let migrated = 0;
  let missing = 0;
  let planned = 0;
  try {
    const files = await client.query(
      `SELECT f.id, f.project_id, f.resource_id, f.storage_key, f.size_bytes, f.mime_type, p.owner_id
       FROM hosting_files f
       INNER JOIN projects p ON p.id = f.project_id
       WHERE f.storage_key !~ '^owners/' AND f.storage_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ORDER BY f.id`,
    );
    for (const row of files.rows) {
      const result = await migrateObject({
        ownerId: String(row.owner_id),
        projectId: String(row.project_id),
        resourceId: String(row.resource_id),
        oldKey: String(row.storage_key),
        expectedSize: Number(row.size_bytes),
        contentType: String(row.mime_type || "application/octet-stream"),
      });
      if (!result) { missing++; console.warn(`Missing legacy upload: file ${row.id}`); continue; }
      planned++;
      if (!APPLY) continue;
      try {
        await client.query("BEGIN");
        const updated = await client.query(
          "UPDATE hosting_files SET storage_key = $1 WHERE id = $2 AND storage_key = $3",
          [result.newKey, row.id, row.storage_key],
        );
        if (updated.rowCount !== 1) throw new Error("File metadata changed during migration; refusing to remove the source.");
        await client.query("COMMIT");
        await unlink(result.oldPath).catch(() => undefined);
        migrated++;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const storage = getStorage();
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: result.newKey })).catch(() => undefined);
        throw error;
      }
    }

    const deployments = await client.query(
      `SELECT d.id, d.project_id, d.resource_id, d.file_manifest, p.owner_id
       FROM hosting_deployments d
       INNER JOIN projects p ON p.id = d.project_id
       WHERE d.file_manifest IS NOT NULL
       ORDER BY d.id`,
    );
    for (const row of deployments.rows) {
      const manifest = Array.isArray(row.file_manifest) ? row.file_manifest : [];
      let changed = false;
      const next = [];
      const sourcePaths: string[] = [];
      for (const entry of manifest) {
        if (!entry || typeof entry !== "object" || typeof entry.storage_key !== "string" || !UUID.test(entry.storage_key)) {
          next.push(entry);
          continue;
        }
        const result = await migrateObject({
          ownerId: String(row.owner_id),
          projectId: String(row.project_id),
          resourceId: String(row.resource_id),
          oldKey: entry.storage_key,
          expectedSize: Number(entry.size_bytes),
          contentType: String(entry.mime_type || "application/octet-stream"),
          deploymentId: String(row.id),
        });
        if (!result) { missing++; next.push(entry); continue; }
        planned++;
        changed = true;
        sourcePaths.push(result.oldPath);
        next.push({ ...entry, storage_key: result.newKey });
      }
      if (!changed || !APPLY) continue;
      try {
        await client.query("BEGIN");
        const updated = await client.query(
          "UPDATE hosting_deployments SET file_manifest = $1::jsonb WHERE id = $2 AND file_manifest = $3::jsonb",
          [JSON.stringify(next), row.id, JSON.stringify(manifest)],
        );
        if (updated.rowCount !== 1) throw new Error("Deployment manifest changed during migration; refusing to remove source files.");
        await client.query("COMMIT");
        for (const sourcePath of sourcePaths) await unlink(sourcePath).catch(() => undefined);
        migrated += sourcePaths.length;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", planned, migrated, missing }, null, 2));
    if (missing > 0) process.exitCode = 2;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  console.error("Website object-storage migration failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
