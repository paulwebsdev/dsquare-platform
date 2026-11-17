import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Pool } from "pg";

const LOCK_NAME = "dsquare-d-hosting-platform-backup";
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

type BackupConfig = {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function getHostingBackupConfig(env: NodeJS.ProcessEnv): BackupConfig | null {
  const required = ["D_HOSTING_BACKUP_BUCKET", "D_HOSTING_BACKUP_ACCESS_KEY_ID", "D_HOSTING_BACKUP_SECRET_ACCESS_KEY"] as const;
  const supplied = required.filter((key) => Boolean(env[key]?.trim()));
  if (supplied.length === 0 && !env.D_HOSTING_BACKUP_ENDPOINT?.trim()) return null;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length || !env.D_HOSTING_BACKUP_ENDPOINT?.trim()) {
    throw new Error(`Incomplete D Hosting backup configuration: ${[...missing, ...(!env.D_HOSTING_BACKUP_ENDPOINT?.trim() ? ["D_HOSTING_BACKUP_ENDPOINT"] : [])].join(", ")}`);
  }
  const endpoint = new URL(env.D_HOSTING_BACKUP_ENDPOINT);
  if (endpoint.protocol !== "https:" && !(env.NODE_ENV !== "production" && endpoint.protocol === "http:")) {
    throw new Error("D_HOSTING_BACKUP_ENDPOINT must use HTTPS in production.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("D_HOSTING_BACKUP_ENDPOINT must not contain credentials, query strings or fragments.");
  }
  const bucket = env.D_HOSTING_BACKUP_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("D_HOSTING_BACKUP_BUCKET is invalid.");
  const prefix = (env.D_HOSTING_BACKUP_PREFIX || "dsquare-d-hosting/platform").trim();
  if (!prefix || prefix.startsWith("/") || prefix.endsWith("/") || prefix.split("/").some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))) {
    throw new Error("D_HOSTING_BACKUP_PREFIX contains an unsafe path.");
  }
  return {
    bucket, prefix, endpoint: endpoint.origin,
    region: (env.D_HOSTING_BACKUP_REGION || "auto").trim(),
    accessKeyId: env.D_HOSTING_BACKUP_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY!,
  };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function dumpPlatformDatabase(): Promise<Buffer> {
  const args = ["--format=custom", "--no-owner", "--no-acl"];
  const databaseUrl = process.env.DB_BACKUP_URL?.trim();
  const env = { ...process.env };
  if (databaseUrl) {
    args.push("--dbname", databaseUrl);
  } else {
    const database = process.env.DB_NAME?.trim();
    const user = process.env.DB_BACKUP_USER?.trim();
    const passwordBase64 = process.env.DB_BACKUP_PASSWORD_BASE64;
    if (!database || !user || !passwordBase64) {
      throw new Error("A dedicated read-only DB_BACKUP_URL or DB_BACKUP_USER/DB_BACKUP_PASSWORD_BASE64 connection is required for platform backups.");
    }
    env.PGPASSWORD = Buffer.from(passwordBase64, "base64").toString("utf8");
    args.push("--host", process.env.DB_BACKUP_HOST || "127.0.0.1");
    args.push("--port", process.env.DB_BACKUP_PORT || "5432");
    args.push("--username", user, "--dbname", database);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PG_DUMP_PATH || "pg_dump", args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BACKUP_BYTES) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("D Hosting platform backup exceeds the 1 GiB safety limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.once("error", (error) => { if (!settled) { settled = true; reject(new Error("pg_dump could not be started; install PostgreSQL client tools.", { cause: error })); } });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && size > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`D Hosting pg_dump failed (exit ${code}): ${stderr.trim().slice(-1000)}`));
    });
  });
}

function createStorage(config: BackupConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export async function runHostingPlatformBackup(pool: Pool): Promise<{ completed: boolean; skipped: boolean }> {
  const config = getHostingBackupConfig(process.env);
  if (!config) return { completed: false, skipped: true };
  const id = randomUUID();
  const objectKey = `${config.prefix}/${id}.dump`;
  await pool.query("INSERT INTO hosting_platform_backups (id, object_key, status) VALUES ($1, $2, 'running')", [id, objectKey]);
  const storage = createStorage(config);
  try {
    const dump = await dumpPlatformDatabase();
    const checksum = sha256(dump);
    await storage.send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: dump, ContentType: "application/octet-stream", Metadata: { sha256: checksum } }));
    const downloaded = await storage.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    if (!downloaded.Body) throw new Error("Backup readback returned an empty body.");
    const readback = Buffer.from(await downloaded.Body.transformToByteArray());
    if (readback.length !== dump.length || sha256(readback) !== checksum) throw new Error("D Hosting backup checksum/readback verification failed.");
    const retention = Number(process.env.D_HOSTING_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    const days = Number.isFinite(retention) ? Math.max(1, Math.min(365, Math.floor(retention))) : DEFAULT_RETENTION_DAYS;
    await pool.query("UPDATE hosting_platform_backups SET status='completed', checksum_sha256=$2, size_bytes=$3, completed_at=NOW(), expires_at=NOW()+($4::integer * INTERVAL '1 day') WHERE id=$1 AND status='running'", [id, checksum, dump.length, days]);
    return { completed: true, skipped: false };
  } catch (error) {
    await storage.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey })).catch(() => undefined);
    await pool.query("UPDATE hosting_platform_backups SET status='failed', error_code='BACKUP_FAILED' WHERE id=$1 AND status='running'", [id]);
    console.error("D Hosting platform backup failed:", error instanceof Error ? error.message : "Unknown error");
    return { completed: false, skipped: false };
  } finally {
    storage.destroy();
  }
}

export async function runHostingBackupRetention(pool: Pool): Promise<number> {
  const config = getHostingBackupConfig(process.env);
  if (!config) return 0;
  const storage = createStorage(config);
  let removed = 0;
  try {
    const result = await pool.query("SELECT id, object_key FROM hosting_platform_backups WHERE status='completed' AND expires_at <= NOW() AND object_key IS NOT NULL ORDER BY expires_at LIMIT 100");
    for (const row of result.rows as Array<{id:string;object_key:string}>) {
      if (!row.object_key.startsWith(`${config.prefix}/`)) continue;
      try {
        await storage.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: row.object_key }));
        await pool.query("UPDATE hosting_platform_backups SET status='expired', error_code='RETENTION_EXPIRED' WHERE id=$1 AND status='completed'", [row.id]);
        removed++;
      } catch (error) {
        console.error("D Hosting backup retention cleanup failed:", error instanceof Error ? error.message : "Unknown error");
      }
    }
  } finally { storage.destroy(); }
  return removed;
}

export async function runHostingBackupScheduledSweep(pool: Pool): Promise<{completed:boolean;skipped:boolean;expired:number}> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [LOCK_NAME]);
    locked = result.rows[0]?.acquired === true;
    if (!locked) return { completed: false, skipped: true, expired: 0 };
    const backup = await runHostingPlatformBackup(client as unknown as Pool);
    const expired = await runHostingBackupRetention(client as unknown as Pool);
    return { ...backup, expired };
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]); }
    finally { client.release(); }
  }
}

export function startHostingBackupScheduler(pool: Pool): void {
  if (process.env.D_HOSTING_BACKUP_SCHEDULER_ENABLED !== "true") {
    console.log("D Hosting platform backup scheduler disabled.");
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { console.log("D Hosting platform backup sweep:", await runHostingBackupScheduledSweep(pool)); }
    catch (error) { console.error("D Hosting backup scheduler failed:", error instanceof Error ? error.message : "Unknown error"); }
    finally { running = false; }
  };
  const requested = Number(process.env.D_HOSTING_BACKUP_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const interval = Number.isFinite(requested) ? Math.max(60 * 60 * 1000, requested) : DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => void run(), interval);
  timer.unref();
  void run();
}
