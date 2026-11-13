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
