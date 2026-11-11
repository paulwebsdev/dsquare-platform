import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../config/database.js";
import { verifyDatabaseBackupPayload } from "./backup-integrity.js";
import { getDatabaseBackupStorageConfig } from "../config/backup-storage-config.js";
import { S3CompatibleBackupStorage, getBackupObjectKey } from "./s3-compatible-backup-storage.js";

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
type ResourceRow = { id: string; project_id: string; schema_name: string };
type BackupRow = { id: string; project_id: string; resource_id: string; object_key: string; checksum_sha256: string; size_bytes: string | number; status: string };

function databaseToolEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.DATABASE_URL && env.DB_PASSWORD_BASE64) {
    env.PGPASSWORD = Buffer.from(env.DB_PASSWORD_BASE64, "base64").toString("utf8");
  }
  return env;
}

function databaseArgs(schemaName: string): string[] {
  if (!/^db_[a-f0-9]{32}$/.test(schemaName)) throw new Error("Invalid database resource schema.");
  const args = ["--no-owner", "--no-acl", "--schema", schemaName];
  if (process.env.DATABASE_URL?.trim()) args.push("--dbname", process.env.DATABASE_URL.trim());
  else {
    const database = process.env.DB_NAME || "";
    const user = process.env.DB_USER || "";
    if (!database || !user) throw new Error("Database connection settings are incomplete for PostgreSQL tools.");
    args.push("--host", process.env.DB_HOST || "127.0.0.1", "--port", process.env.DB_PORT || "5432", "--username", user, "--dbname", database);
  }
  return args;
}

function runDump(schemaName: string): Promise<Buffer> {
  const args = ["--format=custom", "--no-owner", "--no-acl", "--schema", schemaName, ...databaseArgs(schemaName).slice(4)];
  return runTool(process.env.PG_DUMP_PATH || "pg_dump", args);
}

function runRestore(schemaName: string, dump: Buffer): Promise<void> {
  const args = ["--clean", "--if-exists", "--single-transaction", "--exit-on-error", ...databaseArgs(schemaName)];
  return runTool(process.env.PG_RESTORE_PATH || "pg_restore", args, dump).then(() => undefined);
}

function runTool(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: databaseToolEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BACKUP_BYTES) {
        child.kill("SIGTERM");
        reject(new Error("PostgreSQL tool output exceeds the 256 MiB safety limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.once("error", (error) => reject(new Error("PostgreSQL client tool could not be started. Install pg_dump and pg_restore on the worker host.", { cause: error })));
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`PostgreSQL tool failed (exit ${code}): ${stderr.trim().slice(-1000)}`)));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createVerifiedSafetyBackup(client: PoolClient, resource: ResourceRow, storage: S3CompatibleBackupStorage, prefix: string, userId: string): Promise<void> {
  const id = randomUUID();
  const key = getBackupObjectKey(prefix, resource.project_id, resource.id, id);
  await client.query(
    `INSERT INTO database_backups (id, project_id, resource_id, created_by, provider, object_key, status)
     VALUES ($1, $2, $3, $4, 's3-compatible', $5, 'running')`,
    [id, resource.project_id, resource.id, userId, key],
  );
  try {
    const dump = await runDump(resource.schema_name);
    if (!dump.length || dump.length > MAX_BACKUP_BYTES) throw new Error("Safety backup is empty or exceeds the 256 MiB limit.");
    const uploaded = await storage.putObject(key, dump);
    const remote = await storage.getObject(key);
    const checksum = sha256(dump);
    if (uploaded.checksumSha256 !== checksum || uploaded.sizeBytes !== dump.length || sha256(remote.body) !== checksum || remote.body.length !== dump.length) {
      throw new Error("Safety backup integrity verification failed.");
    }
    await client.query(
      `UPDATE database_backups SET status = 'completed', checksum_sha256 = $2, size_bytes = $3,
       completed_at = NOW(), expires_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
      [id, checksum, dump.length],
    );
  } catch (error) {
    await storage.deleteObject(key).catch(() => undefined);
    await client.query("UPDATE database_backups SET status = 'failed', error_code = 'SAFETY_BACKUP_FAILED' WHERE id = $1", [id]);
    throw error;
  }
}

export async function restoreDatabaseBackup(input: { projectId: string; resourceId: string; backupId: string; userId: string }): Promise<void> {
  const config = getDatabaseBackupStorageConfig(process.env);
  if (!config) throw new Error("Database backup storage is not configured.");
  const storage = new S3CompatibleBackupStorage(config);
  const client = await pool.connect();
  let lockAcquired = false;
  let selectedBackupId: string | null = null;
  try {
    const resourceResult = await client.query(
      "SELECT id, project_id, schema_name FROM database_resources WHERE id = $1 AND project_id = $2 AND status = 'active'",
      [input.resourceId, input.projectId],
    );
    const resource = resourceResult.rows[0] as ResourceRow | undefined;
    if (!resource) throw new Error("Database resource not found or is not active.");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [resource.id]);
    lockAcquired = true;

    const backupResult = await client.query(
      `SELECT id, project_id, resource_id, object_key, checksum_sha256, size_bytes, status
       FROM database_backups WHERE id = $1 AND project_id = $2 AND resource_id = $3
       FOR UPDATE`,
      [input.backupId, input.projectId, input.resourceId],
    );
    const backup = backupResult.rows[0] as BackupRow | undefined;
    if (!backup || backup.status !== "completed" || !backup.object_key || !backup.checksum_sha256 || backup.size_bytes == null) {
      throw new Error("A completed, unexpired backup is required for restore.");
    }
    const expectedPrefix = `${config.prefix}/projects/${resource.project_id}/resources/${resource.id}/`;
    if (!backup.object_key.startsWith(expectedPrefix) || backup.object_key.includes("..")) {
      throw new Error("Backup object ownership validation failed.");
    }
    selectedBackupId = backup.id;
    const downloaded = await storage.getObject(backup.object_key);
    const expectedSize = Number(backup.size_bytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_BACKUP_BYTES ||
      downloaded.body.length !== expectedSize || sha256(downloaded.body) !== backup.checksum_sha256) {
      throw new Error("Backup checksum or size verification failed; restore was stopped.");
    }

    await createVerifiedSafetyBackup(client, resource, storage, config.prefix, input.userId);
    await client.query("UPDATE database_backups SET status = 'restoring' WHERE id = $1 AND status = 'completed'", [backup.id]);
    await runRestore(resource.schema_name, downloaded.body);
    await client.query(
      "UPDATE database_backups SET status = 'restored', restored_at = NOW(), error_code = NULL WHERE id = $1 AND status = 'restoring'",
      [backup.id],
    );
  } catch (error) {
    if (selectedBackupId) {
      await client.query(
        "UPDATE database_backups SET status = 'completed', error_code = 'RESTORE_FAILED' WHERE id = $1 AND status = 'restoring'",
        [selectedBackupId],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (lockAcquired) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [input.resourceId]).catch(() => undefined);
    client.release();
  }
}
