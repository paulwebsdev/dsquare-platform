import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/database.js";

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

export type WebsiteObjectStorageQueryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
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

export function assertWebsiteObjectKeyScope(storageKey: string, scope: WebsiteObjectScope): void {
  const prefix = `owners/${scope.ownerId}/projects/${scope.projectId}/websites/${scope.resourceId}/`;
  const objectId = storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : "";
  if (!UUID.test(scope.ownerId) || !UUID.test(scope.projectId) || !UUID.test(scope.resourceId) ||
      !UUID.test(objectId) || storageKey !== prefix + objectId) {
    throw new Error("Website object key does not belong to the requested owner and website.");
  }
}

function missingObjectError(): Error & { code: string } {
  return Object.assign(new Error("Stored website object is missing."), { code: "ENOENT" });
}

/**
 * First-party durable website storage backed by the D Hosting PostgreSQL database.
 * Files are private and scoped by owner, project, and website. The API enforces
 * the per-website quota before calling put(); the table independently caps each
 * object at 10 MiB.
 */
export function createPostgresWebsiteObjectStorage(
  queryable: WebsiteObjectStorageQueryable,
): WebsiteObjectStorage {
  return {
    async put(identity, body, contentType) {
      if (body.byteLength < 1 || body.byteLength > MAX_FILE_BYTES) {
        throw new Error("Website object size is invalid.");
      }
      const key = buildWebsiteObjectKey(identity);
      await queryable.query(
        `INSERT INTO hosting_object_blobs
          (storage_key, owner_id, project_id, resource_id, object_id, content_type, size_bytes, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [key, identity.ownerId, identity.projectId, identity.resourceId, identity.objectId, contentType, body.byteLength, body],
      );
      return key;
    },

    async get(storageKey, scope) {
      assertWebsiteObjectKeyScope(storageKey, scope);
      const result = await queryable.query(
        `SELECT body, size_bytes
         FROM hosting_object_blobs
         WHERE storage_key = $1 AND owner_id = $2 AND project_id = $3 AND resource_id = $4
         LIMIT 1`,
        [storageKey, scope.ownerId, scope.projectId, scope.resourceId],
      );
      if (result.rowCount !== 1 || !Buffer.isBuffer(result.rows[0]?.body)) {
        throw missingObjectError();
      }
      const body = Buffer.from(result.rows[0].body as Buffer);
      if (body.byteLength > MAX_FILE_BYTES || Number(result.rows[0].size_bytes) !== body.byteLength) {
        throw new Error("Stored website object failed its integrity check.");
      }
      return body;
    },

    async delete(storageKey, scope) {
      assertWebsiteObjectKeyScope(storageKey, scope);
      await queryable.query(
        `DELETE FROM hosting_object_blobs
         WHERE storage_key = $1 AND owner_id = $2 AND project_id = $3 AND resource_id = $4`,
        [storageKey, scope.ownerId, scope.projectId, scope.resourceId],
      );
    },
  };
}

function localPath(resourceId: string, storageKey: string): string {
  if (!UUID.test(resourceId) || !UUID.test(storageKey)) {
    throw new Error("Legacy local website storage key is invalid.");
  }
  return path.join(LOCAL_ROOT, resourceId, storageKey);
}

const postgresStorage = createPostgresWebsiteObjectStorage(
  pool as unknown as WebsiteObjectStorageQueryable,
);

const localStorage: WebsiteObjectStorage = {
  async put(identity, body) {
    if (body.byteLength < 1 || body.byteLength > MAX_FILE_BYTES) {
      throw new Error("Website object size is invalid.");
    }
    validIdentity(identity);
    const target = localPath(identity.resourceId, identity.objectId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { flag: "wx", mode: 0o600 });
    return identity.objectId;
  },

  async get(storageKey, scope) {
    return readFile(localPath(scope.resourceId, storageKey));
  },

  async delete(storageKey, scope) {
    await unlink(localPath(scope.resourceId, storageKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  },
};

export const websiteObjectStorage: WebsiteObjectStorage =
  process.env.NODE_ENV === "production" ? postgresStorage : localStorage;

/** Production storage is durable PostgreSQL storage; the API's DB startup check validates connectivity. */
export function assertWebsiteObjectStorageConfigured(): void {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL?.trim() && !process.env.DB_HOST?.trim()) {
    throw new Error("D Hosting PostgreSQL-backed website storage requires a database connection.");
  }
}
