import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { runHostingPlatformBackup } from "../apps/d-hosting/server/src/services/platform-backup-worker.js";
import { runDatabasePlatformBackup } from "../apps/d-database/server/src/services/database-backup-worker.js";

const source = process.env.BACKUP_TEST_SOURCE_DB || "dsquare_backup_source";
const hostingTarget = process.env.BACKUP_TEST_HOSTING_TARGET_DB || "dsquare_restore_hosting_ci";
const databaseTarget = process.env.BACKUP_TEST_DATABASE_TARGET_DB || "dsquare_restore_database_ci";
const pool = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: source });
const s3Objects = new Map<string, Buffer>();
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreArchive(archive: Buffer, target: string, script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "dsquare-platform-backup-"));
  const file = join(dir, "platform.dump");
  try {
    writeFileSync(file, archive);
    const restoreEnv = { ...process.env };
    delete restoreEnv.DATABASE_URL;
    delete restoreEnv.DB_BACKUP_URL;
    delete restoreEnv.D_DATABASE_PLATFORM_BACKUP_URL;
    const result = spawnSync("bash", [script, file, target], { env: restoreEnv, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`pg_restore failed for ${target}: ${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id integer PRIMARY KEY,
      customer_code text NOT NULL UNIQUE,
      name text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id integer PRIMARY KEY,
      customer_id integer NOT NULL REFERENCES customers(id),
      amount numeric(12,2) NOT NULL CHECK (amount >= 0)
    );
    INSERT INTO customers VALUES (1, 'CUST-001', 'Ada'), (2, 'CUST-002', 'Grace')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO orders VALUES (101, 1, 125.50), (102, 2, 80.00)
      ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS hosting_platform_backups (
      id uuid PRIMARY KEY, object_key text NOT NULL UNIQUE, checksum_sha256 char(64),
      size_bytes bigint, status varchar(16) NOT NULL, error_code varchar(64),
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS database_platform_backups (
      id uuid PRIMARY KEY, object_key text NOT NULL UNIQUE, checksum_sha256 char(64),
      size_bytes bigint, status varchar(16) NOT NULL, error_code varchar(64),
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const hostingBackupPassword = process.env.BACKUP_TEST_HOSTING_PASSWORD || "hosting_ci_backup_only";
  const databaseBackupPassword = process.env.BACKUP_TEST_DATABASE_PASSWORD || "database_ci_backup_only";
  const quoteSql = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  for (const [role, password] of [
    ["d_hosting_backup_ci", hostingBackupPassword],
    ["d_database_backup_ci", databaseBackupPassword],
  ] as const) {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (exists.rowCount) {
      await pool.query(`ALTER ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteSql(password)}`);
    } else {
      await pool.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteSql(password)}`);
    }
  }
  await pool.query(`
    GRANT CONNECT ON DATABASE "${source.replace(/"/g, '""')}" TO d_hosting_backup_ci, d_database_backup_ci;
    GRANT USAGE ON SCHEMA public TO d_hosting_backup_ci, d_database_backup_ci;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO d_hosting_backup_ci, d_database_backup_ci;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d_hosting_backup_ci, d_database_backup_ci;
  `);
  const backupUrl = (user: string, password: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${source}`;
  const hostingBackupUrl = backupUrl("d_hosting_backup_ci", hostingBackupPassword);
  const databaseBackupUrl = backupUrl("d_database_backup_ci", databaseBackupPassword);

  for (const url of [hostingBackupUrl, databaseBackupUrl]) {
    const readOnlyPool = new Pool({ connectionString: url });
    try {
      await assert.rejects(
        readOnlyPool.query("INSERT INTO customers (id, customer_code, name) VALUES (999, 'DENIED', 'Denied')"),
        /permission denied/i,
      );
      await assert.rejects(
        readOnlyPool.query("CREATE TABLE backup_role_write_probe (id integer)"),
        /permission denied/i,
      );
      await assert.rejects(
        readOnlyPool.query("CREATE ROLE backup_role_write_probe"),
        /permission denied|must be superuser|permission/i,
      );
    } finally {
      await readOnlyPool.end();
    }
  }

  process.env.DB_BACKUP_URL = hostingBackupUrl;
  process.env.D_HOSTING_BACKUP_ENDPOINT = "https://fake-s3.example.test";
  process.env.D_HOSTING_BACKUP_BUCKET = "private-backups";
  process.env.D_HOSTING_BACKUP_ACCESS_KEY_ID = "ci-access";
  process.env.D_HOSTING_BACKUP_SECRET_ACCESS_KEY = "ci-secret";
  process.env.D_HOSTING_BACKUP_PREFIX = "ci/hosting/platform";

  const hostingStorage = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body;
        if (!body) throw new Error("Hosting upload body missing.");
        s3Objects.set(command.input.Key!, Buffer.from(body as Uint8Array));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = s3Objects.get(command.input.Key!);
        if (!body) throw new Error("Hosting object missing on readback.");
        return { Body: { transformToByteArray: async () => Uint8Array.from(body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        s3Objects.delete(command.input.Key!);
        return {};
      }
      throw new Error("Unexpected S3 command.");
    },
    destroy: () => undefined,
  } as unknown as S3Client;

  const hosting = await runHostingPlatformBackup(pool, { storage: hostingStorage });
  assert.deepEqual(hosting, { completed: true, skipped: false });
  const hostingRow = await pool.query("SELECT object_key, checksum_sha256, size_bytes FROM hosting_platform_backups WHERE status='completed' ORDER BY completed_at DESC LIMIT 1");
  assert.equal(hostingRow.rowCount, 1);
  const hostingArchive = s3Objects.get(hostingRow.rows[0].object_key) ?? Buffer.alloc(0);
  assert.equal(hostingArchive.length, Number(hostingRow.rows[0].size_bytes));
  assert.equal(createHash("sha256").update(hostingArchive).digest("hex"), hostingRow.rows[0].checksum_sha256.trim());
  restoreArchive(hostingArchive, hostingTarget, "apps/d-hosting/server/scripts/restore-platform-backup.sh");

  process.env.D_DATABASE_BACKUP_ENDPOINT = "https://fake-s3.example.test";
  process.env.D_DATABASE_BACKUP_BUCKET = "private-backups";
  process.env.D_DATABASE_BACKUP_ACCESS_KEY_ID = "ci-access";
  process.env.D_DATABASE_BACKUP_SECRET_ACCESS_KEY = "ci-secret";
  process.env.D_DATABASE_BACKUP_PREFIX = "ci/database";
  process.env.D_DATABASE_BACKUP_REGION = "us-east-2";
  process.env.D_DATABASE_PLATFORM_BACKUP_URL = databaseBackupUrl;

  globalThis.fetch = async (input, init = {}) => {
    const key = new URL(String(input)).pathname;
    if (init.method === "PUT") {
      s3Objects.set(key, Buffer.from(init.body as unknown as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (init.method === "GET") {
      const body = s3Objects.get(key);
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (init.method === "DELETE") {
      s3Objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };

  const database = await runDatabasePlatformBackup(pool);
  assert.equal(database, "completed");
  const databaseRow = await pool.query("SELECT object_key, checksum_sha256, size_bytes FROM database_platform_backups WHERE status='completed' ORDER BY completed_at DESC LIMIT 1");
  assert.equal(databaseRow.rowCount, 1);
  const databaseObjectPath = `/${process.env.D_DATABASE_BACKUP_BUCKET}/${databaseRow.rows[0].object_key}`;
  const databaseArchive = s3Objects.get(databaseObjectPath) ?? Buffer.alloc(0);
  assert.equal(databaseArchive.length, Number(databaseRow.rows[0].size_bytes));
  assert.equal(createHash("sha256").update(databaseArchive).digest("hex"), databaseRow.rows[0].checksum_sha256.trim());
  restoreArchive(databaseArchive, databaseTarget, "apps/d-database/server/scripts/restore-platform-backup.sh");

  for (const target of [hostingTarget, databaseTarget]) {
    const verifyPool = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: target });
    try {
      const result = await verifyPool.query("SELECT (SELECT count(*)::int FROM customers) AS customers, (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=101 AND c.customer_code='CUST-001') AS related");
      assert.deepEqual(result.rows[0], { customers: 2, orders: 2, related: 1 });
    } finally {
      await verifyPool.end();
    }
  }
  console.log("Both real platform backup workers produced archives that restored successfully into separate isolated PostgreSQL databases.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await pool.end();
  });
