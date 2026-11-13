import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { lstat, unlink, rm } from "node:fs/promises";
import path from "node:path";
import { enforceXfsProjectQuota, persistentStorageProjectId } from "./persistent-storage-quotas.js";
import { ensurePersistentStorageDirectory } from "./persistent-storage.js";
import { deletePersistentBackupObject, downloadPersistentBackupObject, uploadPersistentBackupObject, type PersistentBackupObjectStore } from "./persistent-storage-object-store.js";
import {
  createPersistentStorageBackup, measurePersistentStorageUsage,
  restorePersistentStorageBackup, tombstonePersistentStorage,
} from "./persistent-storage-backups.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_ID = /^[a-f0-9]{32}$/;
function body(request: Request): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function validId(value: string): boolean { return UUID.test(value); }

export async function initializePersistentStorageLifecycle(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_agent_storage_backups (
      backup_id CHAR(32) PRIMARY KEY,
      resource_id UUID NOT NULL,
      backup_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
      sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'trusted-hosting-api'
    )
  `);
  await pool.query("ALTER TABLE runtime_agent_storage_backups ADD COLUMN IF NOT EXISTS object_key TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS runtime_agent_storage_backups_resource_created_idx ON runtime_agent_storage_backups (resource_id, created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_agent_storage_projects (
      resource_id UUID PRIMARY KEY,
      project_id BIGINT NOT NULL UNIQUE CHECK (project_id > 0),
      hard_limit_bytes BIGINT NOT NULL CHECK (hard_limit_bytes >= 16777216),
      quota_applied_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_agent_storage_audit (
      id BIGSERIAL PRIMARY KEY,
      resource_id UUID NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('backup.create','backup.restore','backup.delete','storage.tombstone')),
      actor TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function registerPersistentStorageLifecycleRoutes(app: Express, input: {
  pool: Pool; storageRoot: string; backupRoot: string; key?: Uint8Array; objectStore?: PersistentBackupObjectStore;
}): void {
  const unavailable = (response: Response) => response.status(503).json({ error: "Persistent backup encryption is not configured on this agent." });
  app.post("/v1/storage/:resourceId/backups", async (request, response) => {
    const resourceId = request.params.resourceId;
    if (!validId(resourceId) || (Buffer.isBuffer(request.body) && request.body.byteLength !== 0)) {
      response.status(400).json({ error: "Storage backup request is invalid." }); return;
    }
    if (!input.key) { unavailable(response); return; }
    if (!input.objectStore) { response.status(503).json({ error: "Offsite backup storage is not configured." }); return; }
    try {
      const backup = await createPersistentStorageBackup(input.storageRoot, input.backupRoot, resourceId, input.key);
      const remote = await uploadPersistentBackupObject(input.objectStore, backup.path, resourceId, backup.backupId);
      await input.pool.query(
        `INSERT INTO runtime_agent_storage_backups (backup_id, resource_id, backup_path, object_key, size_bytes, sha256, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [backup.backupId, resourceId, backup.path, remote.objectKey, backup.sizeBytes, backup.sha256, backup.createdAt],
      );
      await input.pool.query("INSERT INTO runtime_agent_storage_audit (resource_id, action, actor, metadata) VALUES ($1,'backup.create','trusted-hosting-api',$2)", [resourceId, JSON.stringify({ backupId: backup.backupId, sizeBytes: backup.sizeBytes })]);
      response.status(201).json({ backupId: backup.backupId, resourceId, sizeBytes: backup.sizeBytes, sha256: backup.sha256, createdAt: backup.createdAt, offsiteStored: true });
    } catch {
      response.status(409).json({ error: "Persistent storage backup could not be created." });
    }
  });

  app.get("/v1/storage/:resourceId/backups", async (request, response) => {
    const resourceId = request.params.resourceId;
    if (!validId(resourceId)) { response.status(400).json({ error: "Storage resource identifier is invalid." }); return; }
    try {
      const result = await input.pool.query(
        "SELECT backup_id AS \"backupId\", resource_id AS \"resourceId\", size_bytes AS \"sizeBytes\", sha256, created_at AS \"createdAt\", (object_key IS NOT NULL) AS \"offsiteStored\" FROM runtime_agent_storage_backups WHERE resource_id=$1 ORDER BY created_at DESC LIMIT 100",
        [resourceId],
      );
      response.status(200).json({ resourceId, backups: result.rows });
    } catch { response.status(503).json({ error: "Backup history is temporarily unavailable." }); }
  });

  app.post("/v1/storage/:resourceId/backups/:backupId/restore", async (request, response) => {
    const { resourceId, backupId } = request.params;
    if (!validId(resourceId) || !BACKUP_ID.test(backupId) || !body(request) || body(request)?.confirm !== true) {
      response.status(400).json({ error: "Restore requires a valid backup and explicit confirmation." }); return;
    }
    if (!input.key) { unavailable(response); return; }
    try {
      const result = await input.pool.query("SELECT backup_path, object_key, sha256 FROM runtime_agent_storage_backups WHERE backup_id=$1 AND resource_id=$2", [backupId, resourceId]);
      if (!result.rowCount) { response.status(404).json({ error: "Backup was not found." }); return; }
      let backupFile = path.resolve(result.rows[0].backup_path);
      if (path.dirname(backupFile) !== path.resolve(input.backupRoot)) throw new Error("Backup path escaped its private root.");
      let downloaded = false;
      try { await lstat(backupFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !result.rows[0].object_key || !input.objectStore) throw error;
        backupFile = await downloadPersistentBackupObject(input.objectStore, result.rows[0].object_key, input.backupRoot, result.rows[0].sha256);
        downloaded = true;
      }
      try {
        const backupStat = await lstat(backupFile);
        if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw new Error("Backup entry is unsafe.");
        const restored = await restorePersistentStorageBackup(input.storageRoot, backupFile, resourceId, input.key);
        await input.pool.query("INSERT INTO runtime_agent_storage_audit (resource_id, action, actor, metadata) VALUES ($1,'backup.restore','trusted-hosting-api',$2)", [resourceId, JSON.stringify({ backupId, ...restored })]);
        response.status(200).json({ resourceId, backupId, ...restored });
      } finally { if (downloaded) await rm(backupFile, { force: true }); }
    } catch { response.status(409).json({ error: "Backup restore failed safely; live data was not intentionally replaced." }); }
  });

  app.delete("/v1/storage/:resourceId/backups/:backupId", async (request, response) => {
    const { resourceId, backupId } = request.params;
    if (!validId(resourceId) || !BACKUP_ID.test(backupId) || (Buffer.isBuffer(request.body) && request.body.byteLength !== 0)) {
      response.status(400).json({ error: "Backup deletion request is invalid." }); return;
    }
    try {
      const result = await input.pool.query("SELECT backup_path, object_key FROM runtime_agent_storage_backups WHERE backup_id=$1 AND resource_id=$2", [backupId, resourceId]);
      if (!result.rowCount) { response.status(404).json({ error: "Backup was not found." }); return; }
      const file = path.resolve(result.rows[0].backup_path);
      if (path.dirname(file) !== path.resolve(input.backupRoot)) throw new Error("Backup path escaped its private root.");
      if (result.rows[0].object_key) {
        if (!input.objectStore) throw new Error("Offsite backup store is not configured.");
        await deletePersistentBackupObject(input.objectStore, result.rows[0].object_key);
      }
      try {
        const details = await lstat(file);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error("Backup entry is unsafe.");
        await unlink(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await input.pool.query("DELETE FROM runtime_agent_storage_backups WHERE backup_id=$1 AND resource_id=$2", [backupId, resourceId]);
      await input.pool.query("INSERT INTO runtime_agent_storage_audit (resource_id, action, actor, metadata) VALUES ($1,'backup.delete','trusted-hosting-api',$2)", [resourceId, JSON.stringify({ backupId })]);
      response.status(200).json({ resourceId, backupId, deleted: true });
    } catch { response.status(409).json({ error: "Backup could not be safely deleted." }); }
  });


  app.post("/v1/storage/:resourceId/quota", async (request, response) => {
    const resourceId = request.params.resourceId;
    const payload = body(request);
    const hardLimitBytes = payload?.hardLimitBytes;
    if (!validId(resourceId) || !Number.isSafeInteger(hardLimitBytes) || (hardLimitBytes as number) < 16 * 1024 * 1024) {
      response.status(400).json({ error: "Quota request requires a valid resource and hardLimitBytes of at least 16 MiB." }); return;
    }
    try {
      const projectId = persistentStorageProjectId(resourceId);
      const reserved = await input.pool.query(
        `INSERT INTO runtime_agent_storage_projects (resource_id, project_id, hard_limit_bytes)
         VALUES ($1,$2,$3)
         ON CONFLICT (resource_id) DO UPDATE SET hard_limit_bytes=EXCLUDED.hard_limit_bytes, quota_applied_at=NULL, updated_at=NOW()
         RETURNING project_id`,
        [resourceId, projectId, hardLimitBytes],
      );
      const collision = await input.pool.query("SELECT resource_id FROM runtime_agent_storage_projects WHERE project_id=$1 AND resource_id<>$2", [projectId, resourceId]);
      if (collision.rowCount) { response.status(409).json({ error: "Quota project ID collision; operator allocation is required." }); return; }
      await ensurePersistentStorageDirectory(input.storageRoot, resourceId);
      await enforceXfsProjectQuota({ storageRoot: input.storageRoot, resourceId, projectId: Number(reserved.rows[0].project_id), hardLimitBytes: hardLimitBytes as number });
      await input.pool.query("UPDATE runtime_agent_storage_projects SET quota_applied_at=NOW() WHERE resource_id=$1", [resourceId]);
      response.status(200).json({ resourceId, hardLimitBytes, enforcement: "xfs-project-hard-quota", applied: true });
    } catch (error) {
      console.error("Persistent storage quota application failed:", error instanceof Error ? error.message : "Unknown error");
      response.status(503).json({ error: "Filesystem quota could not be applied. Website execution must remain disabled." });
    }
  });

  app.get("/v1/storage/:resourceId/usage", async (request, response) => {
    const resourceId = request.params.resourceId;
    if (!validId(resourceId)) { response.status(400).json({ error: "Storage resource identifier is invalid." }); return; }
    try {
      const usedBytes = await measurePersistentStorageUsage(input.storageRoot, resourceId);
      response.status(200).json({ resourceId, usedBytes, enforcement: "filesystem-project-quota-required" });
    } catch { response.status(404).json({ error: "Persistent storage usage is unavailable." }); }
  });

  app.post("/v1/storage/:resourceId/tombstone", async (request, response) => {
    const resourceId = request.params.resourceId;
    if (!validId(resourceId) || body(request)?.confirm !== true) {
      response.status(400).json({ error: "Storage tombstone requires explicit confirmation." }); return;
    }
    try {
      const tombstone = await tombstonePersistentStorage(input.storageRoot, resourceId);
      await input.pool.query("INSERT INTO runtime_agent_storage_audit (resource_id, action, actor, metadata) VALUES ($1,'storage.tombstone','trusted-hosting-api',$2)", [resourceId, JSON.stringify({ moved: Boolean(tombstone) })]);
      response.status(200).json({ resourceId, tombstoned: Boolean(tombstone) });
    } catch { response.status(409).json({ error: "Persistent storage could not be safely tombstoned." }); }
  });
}
