import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeContainerSpec } from "./container-runtime-contract.js";

const valid = {
  valid: true as const,
  entrypoint: "server.js",
  startCommand: "npm start" as const,
  nodeMajor: 22 as const,
};
const resourceId = "123e4567-e89b-42d3-a456-426614174000";

test("builds a least-privilege Node runtime specification", () => {
  const spec = buildNodeContainerSpec({
    resourceId,
    validation: valid,
    artifactDirectory: "C:\\dsquare\\runtime-artifact",
    environment: { NODE_ENV: "production", DATABASE_URL: "secret" },
    processEnvironment: {},
  });

  assert.equal(spec.name, `dsquare-site-${resourceId}`);
  assert.equal(spec.image, "node:22-bookworm-slim");
  assert.deepEqual(spec.command, ["npm", "start"]);
  assert.deepEqual(spec.mounts, [{ source: "C:\\dsquare\\runtime-artifact", target: "/app", readOnly: true }]);
  assert.equal(spec.environment.PORT, "3000");
  assert.equal(spec.environment.HOSTING_SECRETS_KEY, undefined);
  assert.equal(spec.user, "10001:10001");
  assert.equal(spec.readOnlyRootFilesystem, true);
  assert.deepEqual(spec.capDrop, ["ALL"]);
  assert.deepEqual(spec.securityOpt, ["no-new-privileges:true"]);
  assert.equal(spec.network, "dsquare-hosting-internal");
  assert.equal(spec.pidsLimit, 128);
});

test("uses operator-selected runtime image and bounded resource limits", () => {
  const spec = buildNodeContainerSpec({
    resourceId,
    validation: valid,
    environment: {},
    processEnvironment: {
      HOSTING_NODE_RUNTIME_IMAGE: "registry.example.com/dsquare/node:22",
      HOSTING_RUNTIME_MEMORY_MB: "512",
    },
  });
  assert.equal(spec.image, "registry.example.com/dsquare/node:22");
  assert.equal(spec.memoryBytes, 512 * 1024 * 1024);
});

test("rejects invalid resource IDs, unvalidated projects, and malformed environment", () => {
  assert.throws(() => buildNodeContainerSpec({
    resourceId: "not-a-uuid",
    validation: valid,
    environment: {},
  }), /resource ID/);
  assert.throws(() => buildNodeContainerSpec({
    resourceId,
    validation: { valid: false, error: "missing package" },
    environment: {},
  }), /valid Node.js project/);
  assert.throws(() => buildNodeContainerSpec({
    resourceId,
    validation: valid,
    environment: { "BAD=NAME": "value" },
  }), /invalid, reserved/);
});

test("rejects platform and host secrets from the customer runtime environment", () => {
  for (const name of ["PORT", "PATH", "HOME", "NODE_OPTIONS", "NODE_PATH", "HOSTING_SECRETS_KEY"]) {
    assert.throws(() => buildNodeContainerSpec({
      resourceId,
      validation: valid,
      environment: { [name]: "must-not-cross-boundary" },
    }), /invalid, reserved/);
  }
});

test("rejects oversized runtime environment values", () => {
  assert.throws(() => buildNodeContainerSpec({
    resourceId,
    validation: valid,
    environment: { APP_CONFIG: "x".repeat(16385) },
  }), /oversized/);
});

test("rejects malformed operator image configuration", () => {
  assert.throws(() => buildNodeContainerSpec({
    resourceId,
    validation: valid,
    environment: {},
    processEnvironment: { HOSTING_NODE_RUNTIME_IMAGE: "bad image; rm -rf /" },
  }), /trusted image reference/);
});
