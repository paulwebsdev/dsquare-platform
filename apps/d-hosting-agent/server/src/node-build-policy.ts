import { NODE_BUILDER_IMAGE, verifyNodeBuildCacheAttestation, type NodeBuildCacheAttestation } from "./node-build-cache.js";

/**
 * Security policy for the isolated Node dependency builder.
 *
 * This module only creates a validated build plan. Execution belongs on a
 * dedicated Linux builder using rootless Podman; it must never run in the
 * Hosting API process.
 */
export type NodeBuildPlan = {
  image: typeof NODE_BUILDER_IMAGE;
  cacheMount: { target: "/npm-cache"; readOnly: true };
  install: ["npm", "ci", "--offline", "--cache=/npm-cache", "--ignore-scripts", "--no-audit", "--no-fund"];
  build: ["npm", "run", "build", "--if-present", "--ignore-scripts"];
  network: "none";
  user: "10001:10001";
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  inputMount: { target: "/workspace"; readOnly: true };
  outputMount: { target: "/output"; readOnly: false };
  timeoutMs: number;
  maxOutputBytes: number;
};

export type NodeBuildPlanResult =
  | { valid: true; plan: NodeBuildPlan }
  | { valid: false; error: string };

const MAX_LOCK_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates metadata before a sandboxed npm build. The builder must provide a
 * verified pre-populated npm cache: dependency installation is offline and cannot
 * reach arbitrary package registries. npm lifecycle scripts remain disabled.
 */
export function createNodeBuildPlan(input: {
  packageJson: string;
  packageLockJson: string;
  uploadedPaths: string[];
  limits?: { memoryBytes?: number; nanoCpus?: number; pidsLimit?: number; timeoutMs?: number; maxOutputBytes?: number };
  cacheAttestation?: NodeBuildCacheAttestation;
  cacheSigningKey?: string;
}): NodeBuildPlanResult {
  if (Buffer.byteLength(input.packageJson, "utf8") > MAX_MANIFEST_BYTES ||
      Buffer.byteLength(input.packageLockJson, "utf8") > MAX_LOCK_BYTES) {
    return { valid: false, error: "Node project metadata exceeds the builder limits." };
  }

  let manifest: unknown;
  let lock: unknown;
  try {
    manifest = JSON.parse(input.packageJson);
    lock = JSON.parse(input.packageLockJson);
  } catch {
    return { valid: false, error: "package.json and package-lock.json must contain valid JSON." };
  }
  if (!record(manifest) || !record(lock)) {
    return { valid: false, error: "Node project metadata must contain JSON objects." };
  }
  if (!input.uploadedPaths.includes("package.json") ||
      !input.uploadedPaths.includes("package-lock.json")) {
    return { valid: false, error: "A root package.json and package-lock.json are required." };
  }
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    return { valid: false, error: "Only npm lockfile versions 2 and 3 are supported." };
  }
  if (!record(lock.packages) || !record(lock.packages[""])) {
    return { valid: false, error: "The npm lockfile must contain root package metadata." };
  }
  const root = lock.packages[""];
  if (!record(root) || !record(manifest.scripts) ||
      typeof manifest.scripts.start !== "string" || !manifest.scripts.start.trim()) {
    return { valid: false, error: "A non-empty scripts.start command is required." };
  }
  const packageName = typeof manifest.name === "string" ? manifest.name : undefined;
  if (packageName && root.name !== packageName) {
    return { valid: false, error: "The package manifest does not match the npm lockfile." };
  }
  const nodeRange = record(manifest.engines) ? manifest.engines.node : undefined;
  if (nodeRange !== undefined && (typeof nodeRange !== "string" ||
      !/^(?:22(?:\.x)?|\^22(?:\.\d+\.\d+)?|~22(?:\.\d+\.\d+)?|>=22 <23)$/.test(nodeRange.trim()))) {
    return { valid: false, error: "The isolated builder supports Node.js 22 projects only." };
  }

  const cache = verifyNodeBuildCacheAttestation({
    packageLockJson: input.packageLockJson,
    attestation: input.cacheAttestation,
    signingKey: input.cacheSigningKey,
    builderImage: NODE_BUILDER_IMAGE,
  });
  if (!cache.valid) return { valid: false, error: cache.error };

  const limits = input.limits ?? {};
  const memoryBytes = limits.memoryBytes ?? 512 * 1024 * 1024;
  const nanoCpus = limits.nanoCpus ?? 1_000_000_000;
  const pidsLimit = limits.pidsLimit ?? 128;
  const timeoutMs = limits.timeoutMs ?? 10 * 60 * 1000;
  const maxOutputBytes = limits.maxOutputBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 128 * 1024 * 1024 || memoryBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(nanoCpus) || nanoCpus < 250_000_000 || nanoCpus > 2_000_000_000 ||
      !Number.isInteger(pidsLimit) || pidsLimit < 32 || pidsLimit > 256 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 15 * 60 * 1000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 100 * 1024 * 1024) {
    return { valid: false, error: "Isolated builder resource limits are outside the permitted range." };
  }

  return {
    valid: true,
    plan: {
      image: NODE_BUILDER_IMAGE,
      cacheMount: { target: "/npm-cache", readOnly: true },
      install: ["npm", "ci", "--offline", "--cache=/npm-cache", "--ignore-scripts", "--no-audit", "--no-fund"],
      build: ["npm", "run", "build", "--if-present", "--ignore-scripts"],
      network: "none",
      user: "10001:10001",
      memoryBytes, nanoCpus, pidsLimit,
      inputMount: { target: "/workspace", readOnly: true },
      outputMount: { target: "/output", readOnly: false },
      timeoutMs, maxOutputBytes,
    },
  };
}
