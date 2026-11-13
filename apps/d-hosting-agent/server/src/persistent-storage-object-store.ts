import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, lstat, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAX_BACKUP_BYTES = 600 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_ID = /^[a-f0-9]{32}$/;

export type PersistentBackupObjectStore = {
  client: S3Client;
  bucket: string;
  prefix: string;
};

export function createPersistentBackupObjectStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PersistentBackupObjectStore | undefined {
  const bucket = env.RUNTIME_AGENT_BACKUP_S3_BUCKET?.trim();
  const region = env.RUNTIME_AGENT_BACKUP_S3_REGION?.trim();
  const endpoint = env.RUNTIME_AGENT_BACKUP_S3_ENDPOINT?.trim();
  if (!bucket && !region && !endpoint) return undefined;
  if (!bucket || !region) throw new Error("RUNTIME_AGENT_BACKUP_S3_BUCKET and RUNTIME_AGENT_BACKUP_S3_REGION must be configured together.");
  const accessKeyId = env.RUNTIME_AGENT_BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.RUNTIME_AGENT_BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("Both S3 access key ID and secret access key must be configured together.");
  return {
    client: new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    }),
    bucket,
    prefix: (env.RUNTIME_AGENT_BACKUP_S3_PREFIX?.trim() || "dsquare-hosting").replace(/^\/+|\/+$/g, ""),
  };
}

export function persistentBackupObjectKey(store: PersistentBackupObjectStore, resourceId: string, backupId: string): string {
  if (!UUID.test(resourceId) || !BACKUP_ID.test(backupId)) throw new Error("Persistent backup object identity is invalid.");
  return `${store.prefix}/${resourceId}/${backupId}.dsqbak`;
}

export async function uploadPersistentBackupObject(
  store: PersistentBackupObjectStore, localPath: string, resourceId: string, backupId: string,
): Promise<{ objectKey: string; sizeBytes: number; sha256: string }> {
  const details = await lstat(localPath);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 36 || details.size > MAX_BACKUP_BYTES) {
    throw new Error("Persistent backup object source is invalid.");
  }
  const objectKey = persistentBackupObjectKey(store, resourceId, backupId);
  const digest = createHash("sha256");
  const source = createReadStream(localPath);
  source.on("data", (chunk: Buffer) => digest.update(chunk));
  await store.client.send(new PutObjectCommand({
    Bucket: store.bucket, Key: objectKey, Body: source, ContentLength: details.size,
    ContentType: "application/vnd.dsquare.encrypted-backup", ServerSideEncryption: "AES256",
  }));
  await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: objectKey }));
  return { objectKey, sizeBytes: details.size, sha256: digest.digest("hex") };
}

/** Streams a remote encrypted backup to a private temporary file and verifies its digest. */
export async function downloadPersistentBackupObject(
  store: PersistentBackupObjectStore, objectKey: string, backupRoot: string, expectedSha256: string,
): Promise<string> {
  if (!objectKey.startsWith(store.prefix + "/") || objectKey.includes("..") ||
      !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Persistent backup object reference is invalid.");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(backupRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Persistent backup root is unsafe.");
  const temporary = path.join(backupRoot, `.remote-restore-${randomBytes(12).toString("hex")}.dsqbak`);
  try {
    const result = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: objectKey }));
    if (!result.Body) throw new Error("Persistent backup object is empty.");
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    await pipeline(Readable.from(result.Body as AsyncIterable<Uint8Array>), output);
    const details = await stat(temporary);
    if (details.size < 36 || details.size > MAX_BACKUP_BYTES) throw new Error("Downloaded persistent backup size is invalid.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) digest.update(chunk);
    if (digest.digest("hex") !== expectedSha256) throw new Error("Downloaded persistent backup digest does not match metadata.");
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deletePersistentBackupObject(store: PersistentBackupObjectStore, objectKey: string): Promise<void> {
  if (!objectKey.startsWith(store.prefix + "/") || objectKey.includes("..")) throw new Error("Persistent backup object reference is invalid.");
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: objectKey }));
}
