import assert from "node:assert/strict";
import test from "node:test";
import { createNodeBuildPlan } from "./node-build-policy.js";

const packageJson = JSON.stringify({
  name: "sample-site",
  scripts: { start: "node server.js", build: "tsc" },
  engines: { node: "22.x" },
});
const packageLockJson = JSON.stringify({
  name: "sample-site",
  lockfileVersion: 3,
  packages: { "": { name: "sample-site" } },
});
const paths = ["package.json", "package-lock.json", "server.js"];

test("creates a bounded offline Node 22 build plan", () => {
  const result = createNodeBuildPlan({ packageJson, packageLockJson, uploadedPaths: paths });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.plan.network, "none");
  assert.equal(result.plan.user, "10001:10001");
  assert.deepEqual(result.plan.install, ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.deepEqual(result.plan.build, ["npm", "run", "build", "--if-present", "--ignore-scripts"]);
  assert.equal(result.plan.inputMount.readOnly, true);
  assert.equal(result.plan.outputMount.readOnly, false);
});

test("rejects missing root lockfiles and unsupported lockfile versions", () => {
  assert.equal(createNodeBuildPlan({ packageJson, packageLockJson, uploadedPaths: ["package.json"] }).valid, false);
  const unsupported = JSON.stringify({ lockfileVersion: 1, packages: { "": {} } });
  assert.equal(createNodeBuildPlan({ packageJson, packageLockJson: unsupported, uploadedPaths: paths }).valid, false);
});

test("rejects lockfile mismatch and unsupported Node versions", () => {
  const mismatch = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "other" } } });
  assert.equal(createNodeBuildPlan({ packageJson, packageLockJson: mismatch, uploadedPaths: paths }).valid, false);
  const wrongNode = JSON.stringify({ name: "sample-site", scripts: { start: "node server.js" }, engines: { node: ">=20" } });
  assert.equal(createNodeBuildPlan({ packageJson: wrongNode, packageLockJson, uploadedPaths: paths }).valid, false);
});

test("rejects excessive builder resource limits", () => {
  assert.equal(createNodeBuildPlan({
    packageJson, packageLockJson, uploadedPaths: paths,
    limits: { pidsLimit: 10_000 },
  }).valid, false);
});
