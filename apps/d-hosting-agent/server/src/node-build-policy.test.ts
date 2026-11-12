import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeBuildCacheAttestation,
  getRequiredNodeCacheIntegrities,
  NODE_BUILDER_IMAGE,
} from "./node-build-cache.js";
import { createNodeBuildPlan } from "./node-build-policy.js";

const signingKey = "test-only-builder-cache-key-32-bytes";
const integrity = "sha512-" + "A".repeat(86) + "==";
const packageJson = JSON.stringify({
  name: "sample-site",
  scripts: { start: "node server.js", build: "tsc" },
  engines: { node: "22.x" },
});
const packageLockJson = JSON.stringify({
  name: "sample-site",
  lockfileVersion: 3,
  packages: {
    "": { name: "sample-site", dependencies: { "is-number": "7.0.0" } },
    "node_modules/is-number": {
      version: "7.0.0",
      resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      integrity,
    },
  },
});
const paths = ["package.json", "package-lock.json", "server.js"];
const cacheAttestation = createNodeBuildCacheAttestation({
  packageLockJson,
  builderImage: NODE_BUILDER_IMAGE,
  npmVersion: "10.9.4",
  verifiedCacheIntegrities: [integrity],
  npmCacheVerified: true,
  verifiedAt: "2026-11-12T00:00:00.000Z",
  signingKey,
});

test("creates a bounded Node 22 build plan with a read-only verified npm cache", () => {
  const result = createNodeBuildPlan({
    packageJson, packageLockJson, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey,
  });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.plan.image, NODE_BUILDER_IMAGE);
  assert.equal(result.plan.network, "none");
  assert.equal(result.plan.user, "10001:10001");
  assert.deepEqual(result.plan.install, [
    "npm", "ci", "--offline", "--cache=/npm-cache", "--ignore-scripts", "--no-audit", "--no-fund",
  ]);
  assert.deepEqual(result.plan.build, ["npm", "run", "build", "--if-present", "--ignore-scripts"]);
  assert.deepEqual(result.plan.cacheMount, { target: "/npm-cache", readOnly: true });
  assert.equal(result.plan.inputMount.readOnly, true);
  assert.equal(result.plan.outputMount.readOnly, false);
});

test("rejects missing cache attestations, invalid signatures and changed lockfiles", () => {
  assert.equal(createNodeBuildPlan({ packageJson, packageLockJson, uploadedPaths: paths }).valid, false);
  const wrongKey = createNodeBuildPlan({
    packageJson, packageLockJson, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: "different-signing-key-at-least-32",
  });
  assert.equal(wrongKey.valid, false);
  const changedLock = packageLockJson.replace("7.0.0", "7.0.1");
  const changed = createNodeBuildPlan({
    packageJson, packageLockJson: changedLock, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey,
  });
  assert.equal(changed.valid, false);
});

test("rejects unsupported lockfiles, mismatched project metadata and Node versions", () => {
  const unsupported = JSON.stringify({ lockfileVersion: 1, packages: { "": {} } });
  assert.equal(createNodeBuildPlan({
    packageJson, packageLockJson: unsupported, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey,
  }).valid, false);
  const mismatch = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "other" } } });
  assert.equal(createNodeBuildPlan({
    packageJson, packageLockJson: mismatch, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey,
  }).valid, false);
  const wrongNode = JSON.stringify({
    name: "sample-site", scripts: { start: "node server.js" }, engines: { node: ">=20" },
  });
  assert.equal(createNodeBuildPlan({
    packageJson: wrongNode, packageLockJson, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey,
  }).valid, false);
});

test("rejects missing root files and excessive builder resource limits", () => {
  assert.equal(createNodeBuildPlan({
    packageJson, packageLockJson, uploadedPaths: ["package.json"],
    cacheAttestation, cacheSigningKey: signingKey,
  }).valid, false);
  assert.equal(createNodeBuildPlan({
    packageJson, packageLockJson, uploadedPaths: paths,
    cacheAttestation, cacheSigningKey: signingKey, limits: { pidsLimit: 10_000 },
  }).valid, false);
});

test("accepts only lockfile tarballs from the public npm registry with SHA-512 integrity", () => {
  assert.deepEqual(getRequiredNodeCacheIntegrities(packageLockJson), [integrity]);
  const untrustedLock = packageLockJson.replace(
    "https://registry.npmjs.org/",
    "https://packages.example.com/",
  );
  assert.throws(
    () => getRequiredNodeCacheIntegrities(untrustedLock),
    /Only HTTPS packages from registry.npmjs.org/,
  );
  const missingIntegrity = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/bad": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/bad/-/bad-1.0.0.tgz",
      },
    },
  });
  assert.throws(() => getRequiredNodeCacheIntegrities(missingIntegrity), /SHA-512 integrity/);
});
