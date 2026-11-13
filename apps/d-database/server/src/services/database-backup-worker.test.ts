import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledDatabaseBackupCycle } from "./database-backup-worker.js";

const configKeys = [
  "D_DATABASE_BACKUP_ENDPOINT",
  "D_DATABASE_BACKUP_BUCKET",
  "D_DATABASE_BACKUP_ACCESS_KEY_ID",
  "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
  "D_DATABASE_BACKUP_PREFIX",
  "D_DATABASE_BACKUP_REGION",
] as const;

function withBackupConfig<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    D_DATABASE_BACKUP_ENDPOINT: "https://s3.example.com",
    D_DATABASE_BACKUP_BUCKET: "dsquare-test-backups",
    D_DATABASE_BACKUP_ACCESS_KEY_ID: "test-access-key",
    D_DATABASE_BACKUP_SECRET_ACCESS_KEY: "test-secret-key",
    D_DATABASE_BACKUP_PREFIX: "dsquare-d-database",
    D_DATABASE_BACKUP_REGION: "auto",
  });
  return run().finally(() => {
    for (const key of configKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("skips scheduled backups when private object storage is not configured", async () => {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  let connected = false;
  try {
    const pool = { connect: async () => { connected = true; throw new Error("should not connect"); } } as never;
    const result = await runScheduledDatabaseBackupCycle(pool);
    assert.equal(result.skipped, true);
    assert.equal(result.lockSkipped, false);
    assert.equal(connected, false);
  } finally {
    for (const key of configKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("skips a cycle when another application replica owns the advisory lock", async () => {
  await withBackupConfig(async () => {
    let released = false;
    let queried = false;
    const client = {
      query: async () => ({ rows: [{ locked: false }], rowCount: 1 }),
      release: () => { released = true; },
    };
    const pool = {
      connect: async () => client,
      query: async () => { queried = true; return { rows: [], rowCount: 0 }; },
    } as never;
    const result = await runScheduledDatabaseBackupCycle(pool);
    assert.equal(result.skipped, true);
    assert.equal(result.lockSkipped, true);
    assert.equal(released, true);
    assert.equal(queried, false);
  });
});

test("holds and releases the advisory lock around backup and retention work", async () => {
  await withBackupConfig(async () => {
    const statements: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [{ locked: true }], rowCount: 1 };
      },
      release: () => { released = true; },
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as never;
    const result = await runScheduledDatabaseBackupCycle(pool);
    assert.equal(result.skipped, true);
    assert.equal(result.expired, 0);
    assert.ok(statements.some(sql => sql.includes("pg_try_advisory_lock")));
    assert.ok(statements.some(sql => sql.includes("BACKUP_INTERRUPTED")));
    assert.ok(statements.some(sql => sql.includes("pg_advisory_unlock")));
    assert.equal(released, true);
  });
});
