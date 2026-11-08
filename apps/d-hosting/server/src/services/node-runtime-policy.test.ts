import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNodeRuntimePolicy } from "./node-runtime-policy.js";
import type { NodeProjectValidation } from "./node-project-validation.js";

const valid: NodeProjectValidation = {
  valid: true,
  entrypoint: "server.js",
  startCommand: "npm start",
  nodeMajor: 22,
};

test("allows only validated Node resources when isolation is available", () => {
  assert.deepEqual(evaluateNodeRuntimePolicy({
    siteType: "node",
    resourceStatus: "draft",
    validation: valid,
    isolatedRuntimeAvailable: true,
  }), { allowed: true });
});

test("keeps execution blocked when no isolated runtime provider exists", () => {
  const result = evaluateNodeRuntimePolicy({
    siteType: "node",
    resourceStatus: "draft",
    validation: valid,
    isolatedRuntimeAvailable: false,
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.status, 409);
    assert.match(result.reason, /isolated runtime provider/);
  }
});

test("rejects archived, static, and invalid projects", () => {
  assert.equal(evaluateNodeRuntimePolicy({
    siteType: "static",
    resourceStatus: "draft",
    validation: valid,
    isolatedRuntimeAvailable: true,
  }).allowed, false);
  assert.equal(evaluateNodeRuntimePolicy({
    siteType: "node",
    resourceStatus: "archived",
    validation: valid,
    isolatedRuntimeAvailable: true,
  }).allowed, false);
  assert.equal(evaluateNodeRuntimePolicy({
    siteType: "node",
    resourceStatus: "draft",
    validation: { valid: false, error: "Missing start script." },
    isolatedRuntimeAvailable: true,
  }).allowed, false);
});
