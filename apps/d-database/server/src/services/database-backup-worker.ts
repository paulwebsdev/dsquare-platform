import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getDatabaseBackupStorageConfig } from "../config/backup-storage-config.js";
import { S3CompatibleBackupStorage, getBackupObjectKey } from "./s3-compatible-backup-storage.js";

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function databaseToolEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.DATABASE_URL && env.DB_PASSWORD_BASE64) {
    env.PGPASSWORD = Buffer.from(env.DB_PASSWORD_BASE64, "base64").toString("utf8");
  }
  return env;
}

function dumpSchema(schemaName: string): Promise<Buffer> {
  if (!/^db_[a-f0-9]{32}$/.test(schemaName)) {
    return Promise.reject(new Error("Invalid database resource schema."));
  }

  const args = ["--format=custom", "--no-owner", "--no-acl", "--schema", schemaName];
  if (process.env.DATABASE_URL?.trim()) {
    args.push("--dbname", process.env.DATABASE_URL.trim());
  } else {
    const host = process.env.DB_HOST || "127.0.0.1";
    const port = process.env.DB_PORT || "5432";
    const database = process.env.DB_NAME || "";
    const user = process.env.DB_USER || "";
    if (!database || !user) {
      return Promise.reject(new Error("Database connection settings are incomplete for pg_dump."));
    }
    args.push("--host", host, "--port", port, "--username", user, "--dbname", database);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PG_DUMP_PATH || "pg_dump", args, {
      env: databaseToolEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BACKUP_BYTES) {
        child.kill("SIGTERM");
        reject(new Error("Backup exceeds the configured 256 MiB safety limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.once("error", (error) => reject(new Error("pg_dump could not be started. Install PostgreSQL client tools on the worker host.", { cause: error })));
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`pg_dump failed (exit ${code}): ${stderr.trim().slice(-1000)}`));
    });
  });
}

export async function runDatabaseBackupSweep(pool: Pool | PoolClient): Promise<{ completed: number; failed: number; skipped: boolean }> {
  const config = getDatabaseBackupStorageConfig(process.env);
  if (!config) return { completed: 0, failed: 0, skipped: true };

  const storage = new S3CompatibleBackupStorage(config);
  const resources = await pool.query(
    `SELECT r.id AS resource_id, r.project_id, r.schema_name
     FROM database_resources r
     JOIN projects p ON p.id = r.project_id
     WHERE r.status = 'active' AND p.status = 'active'
     ORDER BY r.created_at ASC`,
  );

  let completed = 0;
  let failed = 0;
  const requestedRetention = Number(process.env.D_DATABASE_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const retentionDays = Number.isFinite(requestedRetention) ? Math.max(1, Math.min(365, Math.floor(requestedRetention))) : DEFAULT_RETENTION_DAYS;

  for (const resource of resources.rows as Array<{ resource_id: string; project_id: string; schema_name: string }>) {
    const backupId = randomUUID();
    const objectKey = getBackupObjectKey(config.prefix, resource.project_id, resource.resource_id, backupId);
    await pool.query(
      `INSERT INTO database_backups (id, project_id, resource_id, provider, object_key, status)
       VALUES ($1, $2, $3, 's3-compatible', $4, 'running')`,
      [backupId, resource.project_id, resource.resource_id, objectKey],
    );

    try {
      const dump = await dumpSchema(resource.schema_name);
      if (dump.length === 0) throw new Error("pg_dump returned an empty backup.");
      const uploaded = await storage.putObject(objectKey, dump);
      const checksum = createHash("sha256").update(dump).digest("hex");
      const remote = await storage.getObject(objectKey);
      const remoteChecksum = createHash("sha256").update(remote.body).digest("hex");
      if (checksum !== uploaded.checksumSha256 || uploaded.sizeBytes !== dump.length || remoteChecksum !== checksum || remote.body.length !== dump.length) {
        throw new Error("Backup upload integrity verification failed.");
      }
      await pool.query(
        `UPDATE database_backups
         SET status = 'completed', checksum_sha256 = $2, size_bytes = $3,
             completed_at = NOW(),
             expires_at = NOW() + ($4::integer * INTERVAL '1 day')
         WHERE id = $1 AND status = 'running'`,
        [backupId, checksum, dump.length, retentionDays],
      );
      completed++;
    } catch (error) {
      await storage.deleteObject(objectKey).catch(() => undefined);
      await pool.query(
        "UPDATE database_backups SET status = 'failed', error_code = 'BACKUP_FAILED' WHERE id = $1 AND status = 'running'",
        [backupId],
      );
      console.error("D Database backup failed:", error instanceof Error ? error.message : "Unknown error");
      failed++;
    }
  }

  return { completed, failed, skipped: false };
}

export async function runDatabaseBackupRetentionSweep(pool: Pool | PoolClient): Promise<number> {
  const config = getDatabaseBackupStorageConfig(process.env);
  if (!config) return 0;
  const storage = new S3CompatibleBackupStorage(config);
  const expired = await pool.query(
    `SELECT id, object_key FROM database_backups
     WHERE status = 'completed' AND expires_at <= NOW() AND object_key IS NOT NULL
     ORDER BY expires_at ASC LIMIT 100`,
  );
  let removed = 0;
  for (const backup of expired.rows as Array<{ id: string; object_key: string }>) {
    try {
      if (!backup.object_key.startsWith(`${config.prefix}/projects/`)) {
        throw new Error("Backup object is outside the D Database prefix.");
      }
      await storage.deleteObject(backup.object_key);
      await pool.query(
        "UPDATE database_backups SET status = 'expired', error_code = 'RETENTION_EXPIRED' WHERE id = $1 AND status = 'completed'",
        [backup.id],
      );
      removed++;
    } catch (error) {
      console.error("D Database backup retention cleanup failed:", error instanceof Error ? error.message : "Unknown error");
    }
  }
  return removed;
}



const PLATFORM_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

async function runDatabasePlatformBackup(pool: Pool | PoolClient): Promise<"completed" | "failed" | "skipped"> {
  const config = getDatabaseBackupStorageConfig(process.env);
  const databaseUrl = process.env.D_DATABASE_PLATFORM_BACKUP_URL?.trim();
  if (!config || !databaseUrl) return "skipped";

  const backupId = randomUUID();
  const objectKey = `${config.prefix}/platform/${backupId}.dump`;
  await pool.query(
    "INSERT INTO database_platform_backups (id, object_key, status) VALUES ($1, $2, 'running')",
    [backupId, objectKey],
  );
  const storage = new S3CompatibleBackupStorage(config);
  try {
    const dump = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.env.PG_DUMP_PATH || "pg_dump", [
        "--format=custom", "--no-owner", "--no-acl", "--dbname", databaseUrl,
      ], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > PLATFORM_BACKUP_MAX_BYTES) {
          settled = true;
          child.kill("SIGTERM");
          reject(new Error("D Database platform backup exceeds the 1 GiB safety limit."));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new Error("pg_dump could not be started for the D Database platform backup.", { cause: error }));
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && size > 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`D Database platform pg_dump failed (exit ${code}): ${stderr.trim().slice(-1000)}`));
      });
    });
    const checksum = createHash("sha256").update(dump).digest("hex");
    const uploaded = await storage.putObject(objectKey, dump);
    const remote = await storage.getObject(objectKey);
    const remoteChecksum = createHash("sha256").update(remote.body).digest("hex");
    if (uploaded.sizeBytes !== dump.length || uploaded.checksumSha256 !== checksum ||
        remote.body.length !== dump.length || remoteChecksum !== checksum) {
      throw new Error("D Database platform backup readback verification failed.");
    }
    const requested = Number(process.env.D_DATABASE_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, Math.floor(requested))) : DEFAULT_RETENTION_DAYS;
    await pool.query(
      "UPDATE database_platform_backups SET status='completed', checksum_sha256=$2, size_bytes=$3, completed_at=NOW(), expires_at=NOW()+($4::integer * INTERVAL '1 day') WHERE id=$1 AND status='running'",
      [backupId, checksum, dump.length, days],
    );
    return "completed";
  } catch (error) {
    await storage.deleteObject(objectKey).catch(() => undefined);
    await pool.query(
      "UPDATE database_platform_backups SET status='failed', error_code='BACKUP_FAILED' WHERE id=$1 AND status='running'",
      [backupId],
    );
    console.error("D Database platform backup failed:", error instanceof Error ? error.message : "Unknown error");
    return "failed";
  }
}

export async function runDatabasePlatformBackupRetention(pool: Pool | PoolClient): Promise<number> {
  const config = getDatabaseBackupStorageConfig(process.env);
  if (!config) return 0;
  const storage = new S3CompatibleBackupStorage(config);
  const expired = await pool.query(
    "SELECT id, object_key FROM database_platform_backups WHERE status='completed' AND expires_at <= NOW() AND object_key IS NOT NULL ORDER BY expires_at LIMIT 100",
  );
  let removed = 0;
  for (const backup of expired.rows as Array<{id:string;object_key:string}>) {
    try {
      if (!backup.object_key.startsWith(`${config.prefix}/platform/`)) {
        throw new Error("Platform backup object is outside the D Database platform prefix.");
      }
      await storage.deleteObject(backup.object_key);
      await pool.query(
        "UPDATE database_platform_backups SET status='expired', error_code='RETENTION_EXPIRED' WHERE id=$1 AND status='completed'",
        [backup.id],
      );
      removed++;
    } catch (error) {
      console.error("D Database platform backup retention cleanup failed:", error instanceof Error ? error.message : "Unknown error");
    }
  }
  return removed;
}

const BACKUP_SCHEDULER_LOCK_NAME = "dsquare-d-database-backup-scheduler";

export type DatabaseBackupScheduledSweepResult = {
  completed: number;
  failed: number;
  skipped: boolean;
  expired: number;
};

/**
 * Ensures only one D Database process performs a scheduled backup/retention sweep.
 * The session advisory lock is held on a dedicated client for the full sweep.
 */
export async function runDatabaseBackupScheduledSweep(
  pool: Pool,
): Promise<DatabaseBackupScheduledSweepResult> {
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [BACKUP_SCHEDULER_LOCK_NAME],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      return { completed: 0, failed: 0, skipped: true, expired: 0 };
    }

    const backup = await runDatabaseBackupSweep(lockClient);
    const platformBackup = await runDatabasePlatformBackup(lockClient);
    const expired = await runDatabaseBackupRetentionSweep(lockClient);
    const platformExpired = await runDatabasePlatformBackupRetention(lockClient);
    return {
      ...backup,
      completed: backup.completed + (platformBackup === "completed" ? 1 : 0),
      failed: backup.failed + (platformBackup === "failed" ? 1 : 0),
      expired: expired + platformExpired,
    };
  } finally {
    try {
      if (lockAcquired) {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtext($1))",
          [BACKUP_SCHEDULER_LOCK_NAME],
        );
      }
    } finally {
      lockClient.release();
    }
  }
}

export function startDatabaseBackupScheduler(pool: Pool): void {
  if (process.env.D_DATABASE_BACKUP_SCHEDULER_ENABLED !== "true") {
    console.log("D Database backup scheduler disabled; set D_DATABASE_BACKUP_SCHEDULER_ENABLED=true to enable it.");
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDatabaseBackupScheduledSweep(pool);
      console.log("D Database backup sweep finished:", result);
    } catch (error) {
      console.error("D Database backup scheduler failed:", error instanceof Error ? error.message : "Unknown error");
    } finally {
      running = false;
    }
  };
  const requestedInterval = Number(process.env.D_DATABASE_BACKUP_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const interval = Number.isFinite(requestedInterval) ? Math.max(60 * 60 * 1000, requestedInterval) : DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => void run(), interval);
  timer.unref();
  void run();
}
