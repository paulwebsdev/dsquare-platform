import assert from "node:assert/strict";
import test from "node:test";
import { getResourceAccessLimits } from "./resource-access-limits.js";

test("uses conservative server-enforced website database defaults", () => {
  assert.deepEqual(getResourceAccessLimits({}), {
    connectionLimit: 5,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 5_000,
    idleInTransactionSessionTimeoutMs: 30_000,
  });
});

test("accepts bounded operator-configured limits", () => {
  assert.deepEqual(getResourceAccessLimits({
    D_DATABASE_RESOURCE_CONNECTION_LIMIT: "8",
    D_DATABASE_RESOURCE_STATEMENT_TIMEOUT_MS: "45000",
    D_DATABASE_RESOURCE_LOCK_TIMEOUT_MS: "3000",
    D_DATABASE_RESOURCE_IDLE_TRANSACTION_TIMEOUT_MS: "20000",
  }), {
    connectionLimit: 8,
    statementTimeoutMs: 45_000,
    lockTimeoutMs: 3_000,
    idleInTransactionSessionTimeoutMs: 20_000,
  });
});

test("rejects zero, excessive and non-numeric limits", () => {
  assert.throws(() => getResourceAccessLimits({ D_DATABASE_RESOURCE_CONNECTION_LIMIT: "0" }), /CONNECTION_LIMIT/);
  assert.throws(() => getResourceAccessLimits({ D_DATABASE_RESOURCE_CONNECTION_LIMIT: "51" }), /CONNECTION_LIMIT/);
  assert.throws(() => getResourceAccessLimits({ D_DATABASE_RESOURCE_STATEMENT_TIMEOUT_MS: "forever" }), /STATEMENT_TIMEOUT/);
  assert.throws(() => getResourceAccessLimits({ D_DATABASE_RESOURCE_LOCK_TIMEOUT_MS: "50" }), /LOCK_TIMEOUT/);
  assert.throws(() => getResourceAccessLimits({ D_DATABASE_RESOURCE_IDLE_TRANSACTION_TIMEOUT_MS: "999999" }), /IDLE_TRANSACTION_TIMEOUT/);
});
