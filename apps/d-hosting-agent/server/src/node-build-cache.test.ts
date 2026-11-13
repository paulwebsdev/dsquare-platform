import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeBuildCacheAttestation,
  getRequiredNodeCacheIntegrities,
  NODE_BUILDER_IMAGE,
  verifyNodeBuildCacheAttestation,
} from "./node-build-cache.js";

const signingKey = "cache-attestation-test-secret-32-bytes";
const integrity = "sha512-" + "B".repeat(86) + "==";
const packageLockJson = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity,
    },
  },
});
const createAttestation = () => createNodeBuildCacheAttestation({
  packageLockJson,
  builderImage: NODE_BUILDER_IMAGE,
  npmVersion: "10.9.4",
  verifiedCacheIntegrities: getRequiredNodeCacheIntegrities(packageLockJson),
  npmCacheVerified: true,
  verifiedAt: "2026-11-12T00:00:00.000Z",
  signingKey,
});

test("creates and verifies a signed cache attestation for the exact lockfile", () => {
  const attestation = createAttestation();
  assert.equal(verifyNodeBuildCacheAttestation({
    packageLockJson, attestation, signingKey, builderImage: NODE_BUILDER_IMAGE,
  }).valid, true);
});

test("rejects a cache attestation signed with another key or altered after signing", () => {
  const attestation = createAttestation();
  assert.equal(verifyNodeBuildCacheAttestation({
    packageLockJson, attestation, signingKey: "another-key-with-at-least-32-bytes",
    builderImage: NODE_BUILDER_IMAGE,
  }).valid, false);
  const tampered = { ...attestation, npmVersion: "10.9.5" };
  assert.equal(verifyNodeBuildCacheAttestation({
    packageLockJson, attestation: tampered, signingKey, builderImage: NODE_BUILDER_IMAGE,
  }).valid, false);
});

test("rejects missing package integrities and unsupported builder toolchains", () => {
  assert.throws(() => createNodeBuildCacheAttestation({
    packageLockJson, builderImage: NODE_BUILDER_IMAGE, npmVersion: "10.9.4",
    verifiedCacheIntegrities: [], npmCacheVerified: true,
    verifiedAt: "2026-11-12T00:00:00.000Z", signingKey,
  }), /missing one or more lockfile packages/);
  assert.throws(() => createNodeBuildCacheAttestation({
    packageLockJson, builderImage: NODE_BUILDER_IMAGE, npmVersion: "11.0.0",
    verifiedCacheIntegrities: [integrity], npmCacheVerified: true,
    verifiedAt: "2026-11-12T00:00:00.000Z", signingKey,
  }), /npm 10 toolchain/);
  assert.throws(() => createNodeBuildCacheAttestation({
    packageLockJson, builderImage: NODE_BUILDER_IMAGE, npmVersion: "10.9.4",
    verifiedCacheIntegrities: [integrity], npmCacheVerified: true,
    verifiedAt: "not-a-date", signingKey,
  }), /must be verified/);
});

test("rejects a different lockfile and a weak signing key", () => {
  const attestation = createAttestation();
  assert.equal(verifyNodeBuildCacheAttestation({
    packageLockJson: packageLockJson + " ",
    attestation, signingKey, builderImage: NODE_BUILDER_IMAGE,
  }).valid, false);
  assert.throws(() => createNodeBuildCacheAttestation({
    packageLockJson, builderImage: NODE_BUILDER_IMAGE, npmVersion: "10.9.4",
    verifiedCacheIntegrities: [integrity], npmCacheVerified: true,
    verifiedAt: "2026-11-12T00:00:00.000Z", signingKey: "short",
  }), /not configured securely/);
});
