import assert from "node:assert/strict";
import test from "node:test";
import { getDatabasePoolOptions } from "./pool-options.js";

test("uses safe pool defaults and enables connection keepalive", () => {
  const options = getDatabasePoolOptions({});
  assert.equal(options.max, 10);
  assert.equal(options.idleTimeoutMillis, 30_000);
  assert.equal(options.connectionTimeoutMillis, 5_000);
  assert.equal(options.keepAlive, true);
  assert.equal(options.maxLifetimeSeconds, 1_800);
  assert.equal(options.application_name, "dsquare-d-hosting");
});

test("accepts bounded pool settings from the environment", () => {
  const options = getDatabasePoolOptions({
    DB_POOL_MAX: "20",
    DB_POOL_IDLE_TIMEOUT_MS: "45000",
    DB_POOL_CONNECTION_TIMEOUT_MS: "7000",
    DB_POOL_MAX_LIFETIME_SECONDS: "900",
    DB_APPLICATION_NAME: "hosting-worker",
  });
  assert.equal(options.max, 20);
  assert.equal(options.idleTimeoutMillis, 45_000);
  assert.equal(options.connectionTimeoutMillis, 7_000);
  assert.equal(options.maxLifetimeSeconds, 900);
  assert.equal(options.application_name, "hosting-worker");
});

test("rejects unsafe or invalid pool limits", () => {
  assert.throws(() => getDatabasePoolOptions({ DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
  assert.throws(() => getDatabasePoolOptions({ DB_POOL_MAX: "51" }), /DB_POOL_MAX/);
  assert.throws(() => getDatabasePoolOptions({ DB_POOL_CONNECTION_TIMEOUT_MS: "fast" }), /DB_POOL_CONNECTION_TIMEOUT_MS/);
});
