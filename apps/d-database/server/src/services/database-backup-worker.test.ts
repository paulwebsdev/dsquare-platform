import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { runDatabaseBackupScheduledSweep } from "./database-backup-worker.js";

function createPool(acquired: boolean) {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ acquired }] : [{}], rowCount: 1 };
    },
    release: () => { released = true; },
  };
  const pool = {
    connect: async () => client,
    query: async () => { throw new Error("Scheduled sweep must use the locked client"); },
  } as unknown as Pool;
  return { pool, calls, wasReleased: () => released };
}

test("skips a scheduled sweep when another process holds the advisory lock", async () => {
  const fake = createPool(false);
  const result = await runDatabaseBackupScheduledSweep(fake.pool);

  assert.deepEqual(result, { completed: 0, failed: 0, skipped: true, expired: 0 });
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0], /pg_try_advisory_lock/);
  assert.equal(fake.wasReleased(), true);
});

test("releases the distributed lock and client after an acquired no-storage sweep", async () => {
  const keys = [
    "D_DATABASE_BACKUP_ENDPOINT",
    "D_DATABASE_BACKUP_BUCKET",
    "D_DATABASE_BACKUP_ACCESS_KEY_ID",
    "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => { delete process.env[key]; });

  try {
    const fake = createPool(true);
    const result = await runDatabaseBackupScheduledSweep(fake.pool);

    assert.deepEqual(result, { completed: 0, failed: 0, skipped: true, expired: 0 });
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[0], /pg_try_advisory_lock/);
    assert.match(fake.calls[1], /pg_advisory_unlock/);
    assert.equal(fake.wasReleased(), true);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("releases the advisory lock when backup configuration validation fails", async () => {
  const keys = [
    "D_DATABASE_BACKUP_ENDPOINT",
    "D_DATABASE_BACKUP_BUCKET",
    "D_DATABASE_BACKUP_ACCESS_KEY_ID",
    "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => { delete process.env[key]; });
  process.env.D_DATABASE_BACKUP_ENDPOINT = "https://storage.example.com";

  try {
    const fake = createPool(true);
    await assert.rejects(runDatabaseBackupScheduledSweep(fake.pool), /Incomplete D Database backup storage configuration/);
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[1], /pg_advisory_unlock/);
    assert.equal(fake.wasReleased(), true);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});


import {
  runDatabaseBackupRetentionSweep,
  runDatabasePlatformBackup,
  runDatabasePlatformBackupRetention,
} from "./database-backup-worker.js";

async function withBackupStorage<T>(run: () => Promise<T>, fetcher: typeof fetch): Promise<T> {
  const keys = [
    "D_DATABASE_BACKUP_ENDPOINT",
    "D_DATABASE_BACKUP_BUCKET",
    "D_DATABASE_BACKUP_ACCESS_KEY_ID",
    "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
    "D_DATABASE_BACKUP_PREFIX",
    "D_DATABASE_BACKUP_REGION",
    "NODE_ENV",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const originalFetch = globalThis.fetch;
  process.env.D_DATABASE_BACKUP_ENDPOINT = "https://storage.example.test";
  process.env.D_DATABASE_BACKUP_BUCKET = "private-backups";
  process.env.D_DATABASE_BACKUP_ACCESS_KEY_ID = "test-access";
  process.env.D_DATABASE_BACKUP_SECRET_ACCESS_KEY = "test-secret";
  process.env.D_DATABASE_BACKUP_PREFIX = "dsquare/database";
  process.env.D_DATABASE_BACKUP_REGION = "us-east-2";
  delete process.env.NODE_ENV;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

test("retention deletes only expired resource objects and preserves required object keys", async () => {
  const updates: string[] = [];
  const deleted: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, object_key FROM database_backups")) {
        return { rows: [
          { id: "expired-1", object_key: "dsquare/database/projects/a/resources/b/expired.dump" },
          { id: "outside-prefix", object_key: "other-prefix/projects/a/resources/b/unsafe.dump" },
        ], rowCount: 2 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const removed = await withBackupStorage(
    () => runDatabaseBackupRetentionSweep(pool),
    async (input, init = {}) => {
      deleted.push(new URL(String(input)).pathname);
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(removed, 1);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /private-backups\/dsquare\/database\/projects/);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /status = 'expired'/);
  assert.doesNotMatch(updates[0], /object_key\s*=\s*NULL/i);
});

test("retention leaves metadata active when object deletion fails", async () => {
  const updates: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, object_key FROM database_backups")) {
        return { rows: [{ id: "expired-2", object_key: "dsquare/database/projects/a/resources/b/expired.dump" }], rowCount: 1 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const removed = await withBackupStorage(
    () => runDatabaseBackupRetentionSweep(pool),
    async () => new Response(null, { status: 503 }),
  );

  assert.equal(removed, 0);
  assert.equal(updates.length, 0);
});

test("platform retention deletes expired platform objects and preserves required object keys", async () => {
  const updates: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM database_platform_backups")) {
        return { rows: [{ id: "platform-expired", object_key: "dsquare/database/platform/expired.dump" }], rowCount: 1 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const removed = await withBackupStorage(
    () => runDatabasePlatformBackupRetention(pool),
    async () => new Response(null, { status: 204 }),
  );

  assert.equal(removed, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /status='expired'/);
  assert.doesNotMatch(updates[0], /object_key\s*=\s*NULL/i);
});

test("platform retention keeps completed metadata when storage deletion fails", async () => {
  const updates: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM database_platform_backups")) {
        return { rows: [{ id: "platform-failed", object_key: "dsquare/database/platform/failed.dump" }], rowCount: 1 };
      }
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const removed = await withBackupStorage(
    () => runDatabasePlatformBackupRetention(pool),
    async () => new Response(null, { status: 403 }),
  );

  assert.equal(removed, 0);
  assert.equal(updates.length, 0);
});


async function withPlatformBackupEnv<T>(run: () => Promise<T>): Promise<T> {
  const keys = [
    "D_DATABASE_BACKUP_ENDPOINT",
    "D_DATABASE_BACKUP_BUCKET",
    "D_DATABASE_BACKUP_ACCESS_KEY_ID",
    "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
    "D_DATABASE_BACKUP_PREFIX",
    "D_DATABASE_BACKUP_REGION",
    "D_DATABASE_PLATFORM_BACKUP_URL",
    "NODE_ENV",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.D_DATABASE_BACKUP_ENDPOINT = "https://storage.example.test";
  process.env.D_DATABASE_BACKUP_BUCKET = "private-backups";
  process.env.D_DATABASE_BACKUP_ACCESS_KEY_ID = "test-access";
  process.env.D_DATABASE_BACKUP_SECRET_ACCESS_KEY = "test-secret";
  process.env.D_DATABASE_BACKUP_PREFIX = "dsquare/database";
  process.env.D_DATABASE_BACKUP_REGION = "us-east-2";
  process.env.D_DATABASE_PLATFORM_BACKUP_URL = "postgresql://backup-role:secret@127.0.0.1:5432/dsquare_ci";
  delete process.env.NODE_ENV;
  try { return await run(); }
  finally {
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]!);
  }
}

test("database platform worker records interrupted pg_dump as failed without uploading", async () => {
  const statements: string[] = [];
  let uploads = 0;
  const pool = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 1 }; } } as unknown as Pool;
  const storage = {
    putObject: async () => { uploads++; return { checksumSha256: "x", sizeBytes: 1 }; },
    getObject: async () => ({ body: Buffer.from("x"), checksumSha256: "x" }),
    deleteObject: async () => undefined,
  };
  const result = await withPlatformBackupEnv(() => runDatabasePlatformBackup(pool, {
    dump: async () => { throw new Error("simulated interrupted pg_dump"); },
    storage,
  }));
  assert.equal(result, "failed");
  assert.equal(uploads, 0);
  assert.ok(statements.some((sql) => sql.includes("status='failed'")));
});

test("database platform worker marks interrupted uploads failed and attempts cleanup", async () => {
  const statements: string[] = [];
  const deleted: string[] = [];
  const pool = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 1 }; } } as unknown as Pool;
  const storage = {
    putObject: async () => { throw new Error("simulated interrupted upload"); },
    getObject: async () => { throw new Error("readback must not run after upload failure"); },
    deleteObject: async (key: string) => { deleted.push(key); },
  };
  const result = await withPlatformBackupEnv(() => runDatabasePlatformBackup(pool, {
    dump: async () => Buffer.from("valid custom archive bytes"),
    storage,
  }));
  assert.equal(result, "failed");
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^dsquare\/database\/platform\/.+\.dump$/);
  assert.ok(statements.some((sql) => sql.includes("status='failed'")));
});

test("database platform worker rejects readback corruption and never marks it completed", async () => {
  const statements: string[] = [];
  const deleted: string[] = [];
  const pool = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 1 }; } } as unknown as Pool;
  const storage = {
    putObject: async (_key: string, body: Buffer) => ({ checksumSha256: "wrong", sizeBytes: body.length }),
    getObject: async () => ({ body: Buffer.from("corrupt"), checksumSha256: "wrong" }),
    deleteObject: async (key: string) => { deleted.push(key); },
  };
  const result = await withPlatformBackupEnv(() => runDatabasePlatformBackup(pool, {
    dump: async () => Buffer.from("valid custom archive bytes"),
    storage,
  }));
  assert.equal(result, "failed");
  assert.equal(deleted.length, 1);
  assert.ok(statements.some((sql) => sql.includes("status='failed'")));
  assert.equal(statements.some((sql) => sql.includes("status='completed'")), false);
});
