import { createHash } from "node:crypto";
import { mkdir, lstat, chmod, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createNodeBuildCacheAttestation,
  getRequiredNodeCacheIntegrities,
  NODE_BUILDER_IMAGE,
  type NodeBuildCacheAttestation,
} from "./node-build-cache.js";

type RequiredPackage = { resolved: string; integrity: string };

function requiredPackages(packageLockJson: string): RequiredPackage[] {
  // The shared validator rejects unsupported sources and missing integrity data.
  const required = new Set(getRequiredNodeCacheIntegrities(packageLockJson));
  const parsed = JSON.parse(packageLockJson) as {
    packages: Record<string, { link?: boolean; resolved?: string; integrity?: string }>;
  };
  const packages = new Map<string, RequiredPackage>();
  for (const [path, item] of Object.entries(parsed.packages)) {
    if (!path || item.link === true || typeof item.resolved !== "string" ||
        typeof item.integrity !== "string") continue;
    const integrity = item.integrity.split(/\s+/).find((value) => required.has(value));
    if (integrity) packages.set(item.resolved + "|" + integrity, { resolved: item.resolved, integrity });
  }
  return [...packages.values()];
}

export type NpmCacheCommandRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

export const runNpmCacheCommand: NpmCacheCommandRunner = (args, cwd, timeoutMs) =>
  new Promise((resolveOutput, reject) => {
    const child = spawn("npm", args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        npm_config_registry: "https://registry.npmjs.org/",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    };
    const collect = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > 128 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("npm cache command output exceeded its limit."));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error("npm cache command failed."));
      else finish();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("npm cache command timed out."));
    }, timeoutMs);
  });

async function verifyCacheContent(cacheDirectory: string, integrity: string): Promise<void> {
  const [algorithm, encodedDigest] = integrity.split("-", 2);
  if (algorithm !== "sha512" || !encodedDigest) {
    throw new Error("The npm cache contains an unsupported integrity algorithm.");
  }
  const expected = Buffer.from(encodedDigest, "base64");
  if (expected.byteLength !== 64) throw new Error("The npm package integrity value is malformed.");
  const hex = expected.toString("hex");
  const contentPath = join(
    cacheDirectory, "_cacache", "content-v2", "sha512",
    hex.slice(0, 2), hex.slice(2, 4), hex.slice(4),
  );
  const fileInfo = await stat(contentPath);
  if (!fileInfo.isFile() || fileInfo.size > 100 * 1024 * 1024) {
    throw new Error("A cached npm package exceeds the permitted size.");
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(contentPath)) hash.update(chunk);
  const actual = hash.digest();
  if (!actual.equals(expected)) throw new Error("A cached npm package failed its SHA-512 integrity check.");
}

/**
 * Populates a dedicated cache using only lockfile-validated npm registry tarballs.
 * Run this only in the trusted Linux cache-provisioning worker, never in the
 * Hosting API process or a customer runtime. The worker's egress firewall must
 * allow the npm registry and deny all other destinations.
 */
export async function provisionNodeBuildCache(input: {
  packageLockJson: string;
  cacheDirectory: string;
  signingKey: string;
  verifiedAt?: string;
  runCommand?: NpmCacheCommandRunner;
}): Promise<{ attestation: NodeBuildCacheAttestation; packageCount: number }> {
  if (Buffer.byteLength(input.packageLockJson, "utf8") > 20 * 1024 * 1024) {
    throw new Error("The npm lockfile exceeds the cache provisioning limit.");
  }
  const cacheDirectory = resolve(input.cacheDirectory);
  if (!input.cacheDirectory || !cacheDirectory.startsWith("/") || cacheDirectory === "/") {
    throw new Error("A dedicated absolute Linux npm cache directory is required.");
  }
  const packages = requiredPackages(input.packageLockJson);
  if (packages.length > 1000) throw new Error("The npm lockfile contains too many packages for cache provisioning.");
  const runCommand = input.runCommand ?? runNpmCacheCommand;
  const deadline = Date.now() + 30 * 60 * 1000;
  const runWithinDeadline = (args: string[], requestedTimeoutMs: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("npm cache provisioning exceeded its total time limit.");
    return runCommand(args, cacheDirectory, Math.min(requestedTimeoutMs, remaining));
  };
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(cacheDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The npm cache path must be a real directory, not a symlink.");
  }
  await chmod(cacheDirectory, 0o700);

  const npmVersion = (await runWithinDeadline(["--version"], 15_000)).trim();
  if (!/^10\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion)) {
    throw new Error("The cache worker must use the approved npm 10 toolchain.");
  }

  for (const item of packages) {
    await runWithinDeadline([
      "cache", "add", item.resolved,
      "--cache", cacheDirectory,
      "--registry", "https://registry.npmjs.org/",
      "--ignore-scripts", "--no-audit", "--no-fund",
      "--userconfig=/dev/null", "--globalconfig=/dev/null",
    ], 5 * 60 * 1000);
  }
  await runWithinDeadline([
    "cache", "verify", "--cache", cacheDirectory,
    "--userconfig=/dev/null", "--globalconfig=/dev/null",
  ], 5 * 60 * 1000);

  const integrities = getRequiredNodeCacheIntegrities(input.packageLockJson);
  for (const integrity of integrities) await verifyCacheContent(cacheDirectory, integrity);

  const attestation = createNodeBuildCacheAttestation({
    packageLockJson: input.packageLockJson,
    builderImage: NODE_BUILDER_IMAGE,
    npmVersion,
    verifiedCacheIntegrities: integrities,
    npmCacheVerified: true,
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    signingKey: input.signingKey,
  });
  return { attestation, packageCount: packages.length };
}
