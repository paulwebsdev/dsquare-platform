import { createHash, createHmac } from "node:crypto";
import type { DatabaseBackupStorageConfig } from "../config/backup-storage-config.js";

type ObjectResponse = { body: Buffer; checksumSha256: string };

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectPath(endpoint: URL, bucket: string, key: string): string {
  const segments = [bucket, ...key.split("/")].map(awsEncode);
  return `${endpoint.pathname.replace(/\/$/, "")}/${segments.join("/")}`.replace(/^$/, "/");
}

export class S3CompatibleBackupStorage {
  constructor(
    private readonly config: DatabaseBackupStorageConfig,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  private async request(method: string, key: string, body?: Buffer): Promise<Response> {
    if (
      !key ||
      key.startsWith("/") ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Invalid backup object key.");
    }

    const endpoint = new URL(this.config.endpoint);
    const path = objectPath(endpoint, this.config.bucket, key);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalHeaders =
      `host:${endpoint.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return this.requestFetch(new URL(path, endpoint.origin), {
      method,
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
        ...(body ? { "content-type": "application/octet-stream" } : {}),
      },
      ...(body ? { body } : {}),
    });
  }

  async putObject(key: string, body: Buffer): Promise<{ checksumSha256: string; sizeBytes: number }> {
    const response = await this.request("PUT", key, body);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Backup storage upload failed (HTTP ${response.status}).`);
    }
    return { checksumSha256: sha256(body), sizeBytes: body.byteLength };
  }

  async getObject(key: string): Promise<ObjectResponse> {
    const response = await this.request("GET", key);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Backup storage download failed (HTTP ${response.status}).`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    return { body, checksumSha256: sha256(body) };
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Backup storage deletion failed (HTTP ${response.status}).`);
    }
  }
}

export function getBackupObjectKey(prefix: string, projectId: string, resourceId: string, backupId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![projectId, resourceId, backupId].every((value) => uuid.test(value))) {
    throw new Error("Backup object ownership identifiers must be UUIDs.");
  }
  if (!prefix || prefix.startsWith("/") || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid backup object prefix.");
  }
  return `${prefix}/projects/${projectId}/resources/${resourceId}/${backupId}.dump`;
}
