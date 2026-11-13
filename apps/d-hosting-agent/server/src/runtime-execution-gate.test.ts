import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRuntimeExecutionGate, type RuntimeExecutionGateInput } from "./runtime-execution-gate.js";

const ready: RuntimeExecutionGateInput = {
  executionRequested: true,
  linuxAcceptanceApproved: true,
  providerConfigured: true,
  builderConfigured: true,
  persistentStorageConfigured: true,
  backupConfigured: true,
  ingressConfigured: true,
  trustedImageConfigured: true,
  privateNetworkConfigured: true,
};

test("enables execution only when every explicit production gate is satisfied", () => {
  assert.deepEqual(evaluateRuntimeExecutionGate(ready), { enabled: true, reasons: [] });
});

test("keeps execution disabled by default", () => {
  const result = evaluateRuntimeExecutionGate({
    ...ready,
    executionRequested: false,
    linuxAcceptanceApproved: false,
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.some((reason) => reason.includes("RUNTIME_AGENT_EXECUTION_ENABLED")));
  assert.ok(result.reasons.some((reason) => reason.includes("LINUX_ACCEPTANCE_APPROVED")));
});

test("fails closed when any runtime dependency is missing", () => {
  const keys = Object.keys(ready) as Array<keyof RuntimeExecutionGateInput>;
  for (const key of keys) {
    const result = evaluateRuntimeExecutionGate({ ...ready, [key]: false });
    assert.equal(result.enabled, false, `expected ${key} to block execution`);
    assert.ok(result.reasons.length >= 1);
  }
});
