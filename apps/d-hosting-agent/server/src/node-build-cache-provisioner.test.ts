import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  provisionNodeBuildCache,
  type NpmCacheCommandRunner,
} from "./node-build-cache-provisioner.js";
import {
  verifyNodeBuildCacheAttestation,
  NODE_BUILDER_IMAGE,
} from "./node-build-cache.js";

const signingKey = "cache-provisioner-test-secret-32-bytes";
const tarball = Buffer.from("trusted package tarball fixture");
const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
const packageLockJson = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/example": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      integrity,
    },
  },
});

test("provisions registry tarballs, verifies npm cache content and signs the lockfile inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsquare-npm-cache-"));
  const cacheDirectory = join(root, "cache");
  const calls: string[][] = [];
  const runner: NpmCacheCommandRunner = async (args, cwd) => {
    calls.push(args);
    if (args[0] === "--version") return "10.9.4";
    if (args[0] === "cache" && args[1] === "add") {
      const digest = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
      const contentPath = join(
        cwd, "_cacache", "content-v2", "sha512",
        digest.slice(0, 2), digest.slice(2, 4), digest.slice(4),
      );
      await mkdir(join(contentPath, ".."), { recursive: true });
      await writeFile(contentPath, tarball);
      return "added";
    }
    if (args[0] === "cache" && args[1] === "verify") return "Cache verified";
    throw new Error("Unexpected npm command in test.");
  };

  try {
    const result = await provisionNodeBuildCache({
      packageLockJson, cacheDirectory, signingKey,
      verifiedAt: "2026-11-12T00:00:00.000Z", runCommand: runner,
    });
    assert.equal(result.packageCount, 1);
    assert.equal(verifyNodeBuildCacheAttestation({
      packageLockJson, attestation: result.attestation,
      signingKey, builderImage: NODE_BUILDER_IMAGE,
    }).valid, true);
    assert.deepEqual(calls[0], ["--version"]);
    assert.equal(calls[1]?.[0], "cache");
    assert.equal(calls[1]?.[1], "add");
    assert.equal(calls[1]?.[2], "https://registry.npmjs.org/example/-/example-1.0.0.tgz");
    assert.ok(calls[1]?.includes("--ignore-scripts"));
    assert.equal(calls[2]?.[1], "verify");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not attest a cache when npm provisioning fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsquare-npm-cache-fail-"));
  try {
    const runner: NpmCacheCommandRunner = async (args) => {
      if (args[0] === "--version") return "10.9.4";
      throw new Error("registry download failed");
    };
    await assert.rejects(() => provisionNodeBuildCache({
      packageLockJson, cacheDirectory: join(root, "cache"), signingKey, runCommand: runner,
    }), /registry download failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a cache directory that is a symbolic link", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsquare-npm-cache-link-"));
  const realDirectory = join(root, "real");
  const linkDirectory = join(root, "link");
  await mkdir(realDirectory);
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(realDirectory, linkDirectory, "dir");
    await assert.rejects(() => provisionNodeBuildCache({
      packageLockJson, cacheDirectory: linkDirectory, signingKey,
      runCommand: async () => "10.9.4",
    }), /real directory, not a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
