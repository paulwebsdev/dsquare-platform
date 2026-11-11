import assert from "node:assert/strict";
import test from "node:test";
import {
  getRuntimeEnvironmentCapacityError,
  MAX_RUNTIME_ENVIRONMENT_BYTES,
  MAX_RUNTIME_ENVIRONMENT_VARIABLES,
} from "./runtime-environment-policy.js";

test("allows a new variable within the count and aggregate byte budgets", () => {
  assert.equal(getRuntimeEnvironmentCapacityError(3, 1024, 512), null);
  assert.equal(getRuntimeEnvironmentCapacityError(99, 0, 1), null);
  assert.equal(getRuntimeEnvironmentCapacityError(0, MAX_RUNTIME_ENVIRONMENT_BYTES - 1, 1), null);
});

test("rejects a new variable when the per-website variable count is full", () => {
  assert.match(
    getRuntimeEnvironmentCapacityError(MAX_RUNTIME_ENVIRONMENT_VARIABLES, 0, 1) ?? "",
    /at most 100/,
  );
});

test("rejects values that exceed the aggregate 64 KiB budget", () => {
  assert.match(
    getRuntimeEnvironmentCapacityError(0, MAX_RUNTIME_ENVIRONMENT_BYTES, 1) ?? "",
    /64 KiB/,
  );
});

test("rejects invalid capacity measurements", () => {
  assert.throws(() => getRuntimeEnvironmentCapacityError(-1, 0, 1), /invalid/);
  assert.throws(() => getRuntimeEnvironmentCapacityError(0, 0, 0), /invalid/);
});
