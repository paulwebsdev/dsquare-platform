import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeContainerSpec } from "./container-runtime-contract.js";
import type { NodeProjectValidation } from "./node-project-validation.js";
import { buildRemoteRuntimeCreateRequest } from "./runtime-agent-contract.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";
const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const artifact = {
  artifactId: "123e4567-e89b-42d3-a456-426614174002",
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  fileCount: 3,
};
const validation = { valid: true } as NodeProjectValidation;
const spec = buildNodeContainerSpec({
  resourceId,
  validation,
  artifactDirectory: "C:\\runtime\\artifact",
  environment: { NODE_ENV: "production" },
  processEnvironment: {},
});

test("creates a transport-safe request without local host paths or network names", () => {
  const request = buildRemoteRuntimeCreateRequest({ resourceId, deploymentId, spec, artifact });
  assert.equal(request.runtime.name, `dsquare-site-${resourceId}`);
  assert.equal(request.runtime.environment.PORT, "3000");
  assert.equal("mounts" in request.runtime, false);
  assert.equal(JSON.stringify(request).includes("C:\\\\runtime"), false);
  assert.equal(JSON.stringify(request).includes("dsquare-hosting-internal"), false);
});

test("rejects invalid artifact metadata and weakened isolation settings", () => {
  assert.throws(() => buildRemoteRuntimeCreateRequest({
    resourceId, deploymentId, spec, artifact: { ...artifact, sizeBytes: 0 },
  }), /artifact metadata/);
  assert.throws(() => buildRemoteRuntimeCreateRequest({
    resourceId, deploymentId,
    spec: { ...spec, readOnlyRootFilesystem: false },
    artifact,
  }), /isolation contract/);
  assert.throws(() => buildRemoteRuntimeCreateRequest({
    resourceId, deploymentId,
    spec: { ...spec, environment: { ...spec.environment, PORT: "9999" } },
    artifact,
  }), /PORT/);
});
