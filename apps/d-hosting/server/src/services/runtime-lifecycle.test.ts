import assert from "node:assert/strict";
import test from "node:test";
import { canRetryRuntime, transitionRuntimeState } from "./runtime-lifecycle.js";

test("allows the normal start and stop lifecycle", () => {
  let state = transitionRuntimeState("queued", "preparing");
  state = transitionRuntimeState(state, "starting");
  state = transitionRuntimeState(state, "running");
  state = transitionRuntimeState(state, "stopping");
  state = transitionRuntimeState(state, "stopped");
  assert.equal(state, "stopped");
});

test("allows failures and retries from stopped or failed states", () => {
  assert.equal(transitionRuntimeState("starting", "failed"), "failed");
  assert.equal(transitionRuntimeState("failed", "queued"), "queued");
  assert.equal(transitionRuntimeState("stopped", "queued"), "queued");
  assert.equal(canRetryRuntime("failed"), true);
  assert.equal(canRetryRuntime("stopped"), true);
  assert.equal(canRetryRuntime("running"), false);
});

test("rejects skipped or unsafe lifecycle transitions", () => {
  assert.throws(() => transitionRuntimeState("queued", "running"), /Invalid runtime state transition/);
  assert.throws(() => transitionRuntimeState("running", "starting"), /Invalid runtime state transition/);
  assert.throws(() => transitionRuntimeState("stopped", "running"), /Invalid runtime state transition/);
});
