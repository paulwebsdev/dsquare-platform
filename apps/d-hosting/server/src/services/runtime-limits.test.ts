import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeLimits } from "./runtime-limits.js";

test("provides conservative defaults for isolated runtimes", () => {
  assert.deepEqual(getRuntimeLimits({}), {
    memoryBytes: 256 * 1024 * 1024,
    nanoCpus: 500_000_000,
    pidsLimit: 128,
    startupTimeoutMs: 30_000,
  });
});

test("converts configured limits into container runtime units", () => {
  assert.deepEqual(getRuntimeLimits({
    HOSTING_RUNTIME_MEMORY_MB: "512",
    HOSTING_RUNTIME_CPU_CORES: "1.5",
    HOSTING_RUNTIME_PIDS_LIMIT: "256",
    HOSTING_RUNTIME_STARTUP_TIMEOUT_MS: "45000",
  }), {
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_500_000_000,
    pidsLimit: 256,
    startupTimeoutMs: 45_000,
  });
});

test("rejects unsafe or malformed resource limits", () => {
  assert.throws(() => getRuntimeLimits({ HOSTING_RUNTIME_MEMORY_MB: "32" }), /between 64 and 4096/);
  assert.throws(() => getRuntimeLimits({ HOSTING_RUNTIME_CPU_CORES: "8" }), /between 0.1 and 4/);
  assert.throws(() => getRuntimeLimits({ HOSTING_RUNTIME_PIDS_LIMIT: "0" }), /positive number/);
  assert.throws(() => getRuntimeLimits({ HOSTING_RUNTIME_STARTUP_TIMEOUT_MS: "1000" }), /between 5000 and 120000/);
});
