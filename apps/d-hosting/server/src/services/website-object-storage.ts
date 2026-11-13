import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ROOT = path.resolve(process.env.HOSTING_STORAGE_ROOT || path.join(process.cwd(), "storage", "sites"));

export type WebsiteObjectIdentity = {
  ownerId: string;
  projectId: string;
  resourceId: string;
  objectId: string;
};

export type WebsiteObjectScope = Pick<WebsiteObjectIdentity, "ownerId" | "projectId" | "resourceId">;

export type WebsiteObjectStorage = {
  put(identity: WebsiteObjectIdentity, body: Buffer, contentType: string): Promise<string>;
  get(storageKey: string, scope: WebsiteObjectScope): Promise<Buffer>;
  delete(storageKey: string, scope: WebsiteObjectScope): Promise<void>;
};

function validIdentity(identity: WebsiteObjectIdentity): void {
  for (const value of [identity.ownerId, identity.projectId, identity.resourceId, identity.objectId]) {
    if (!UUID.test(value)) throw new Error("Website object identity is invalid.");
  }
}

export function buildWebsiteObjectKey(identity: WebsiteObjectIdentity): string {
  validIdentity(identity);
  return `owners/${identity.ownerId}/projects/${identity.projectId}/websites/${identity.resourceId}/${identity.objectId}`;
}

function s3Config() {
  const bucket = process.env.HOSTING_OBJECT_STORAGE_BUCKET?.trim();
  const region = process.env.HOSTING_OBJECT_STORAGE_REGION?.trim();
  const endpoint = process.env.HOSTING_OBJECT_STORAGE_ENDPOINT?.trim();
  const accessKeyId = process.env.HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  const configured = [bucket, region, accessKeyId, secretAccessKey].some(Boolean) || Boolean(endpoint);
  if (!configured) {
    if (process.env.NODE_ENV === "production") throw new Error("Durable S3-compatible website object storage is not configured.");
    return null;
  }
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3-compatible website object storage requires bucket, region, access key ID, and secret access key.");
  }
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
      throw new Error("Object storage endpoint must use HTTPS (HTTP loopback is allowed only in development).");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Object storage endpoint must be a clean origin.");
  }
  return { bucket, region, endpoint, accessKeyId, secretAccessKey };
}

export function assertWebsiteObjectStorageConfigured(): void {
  if (process.env.NODE_ENV === "production" && !s3Config()) {
    throw new Error("Production D Hosting requires durable S3-compatible website object storage.");
  }
}

let client: S3Client | undefined;
function getS3() {
  const config = s3Config();
  if (!config) return null;
  if (!client) client = new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    forcePathStyle: Boolean(config.endpoint),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return { client, bucket: config.bucket };
}

export function assertWebsiteObjectKeyScope(storageKey: string, scope: WebsiteObjectScope): void {
  const prefix = `owners/${scope.ownerId}/projects/${scope.projectId}/websites/${scope.resourceId}/`;
  const objectId = storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : "";
  if (!UUID.test(scope.ownerId) || !UUID.test(scope.projectId) || !UUID.test(scope.resourceId) ||
      !UUID.test(objectId) || storageKey !== prefix + objectId) {
    throw new Error("Website object key does not belong to the requested owner and website.");
  }
}

function localPath(resourceId: string, storageKey: string): string {
  if (!UUID.test(resourceId) || !UUID.test(storageKey)) throw new Error("Legacy local website storage key is invalid.");
  return path.join(LOCAL_ROOT, resourceId, storageKey);
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body) ||
      typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== "function") {
    throw new Error("Object storage returned an unsupported response body.");
  }
  const bytes = Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Stored website object exceeds the permitted size.");
  return bytes;
}

export const websiteObjectStorage: WebsiteObjectStorage = {
  async put(identity, body, contentType) {
    if (body.byteLength < 1 || body.byteLength > MAX_FILE_BYTES) throw new Error("Website object size is invalid.");
    const key = buildWebsiteObjectKey(identity);
    const s3 = getS3();
    if (s3) {
      await s3.client.send(new PutObjectCommand({
        Bucket: s3.bucket, Key: key, Body: body, ContentLength: body.byteLength,
        ContentType: contentType, Metadata: { owner: identity.ownerId, project: identity.projectId, website: identity.resourceId },
        ServerSideEncryption: "AES256",
      }));
      return key;
    }
    const target = localPath(identity.resourceId, identity.objectId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { flag: "wx", mode: 0o600 });
    return identity.objectId;
  },

  async get(storageKey, scope) {
    if (storageKey.startsWith("owners/")) {
      assertWebsiteObjectKeyScope(storageKey, scope);
      const s3 = getS3();
      if (!s3) throw new Error("S3-compatible object storage is not configured for this object.");
      const response = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: storageKey }));
      return bodyToBuffer(response.Body);
    }
    return readFile(localPath(scope.resourceId, storageKey));
  },

  async delete(storageKey, scope) {
    if (storageKey.startsWith("owners/")) {
      assertWebsiteObjectKeyScope(storageKey, scope);
      const s3 = getS3();
      if (!s3) throw new Error("S3-compatible object storage is not configured for this object.");
      await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: storageKey }));
      return;
    }
    await unlink(localPath(scope.resourceId, storageKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  },
};
