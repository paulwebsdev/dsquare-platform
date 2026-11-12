import path from "node:path";
import type { NodeProjectValidation } from "./node-project-validation.js";
import { isValidEnvironmentName } from "./environment-secrets.js";
import { getRuntimeLimits } from "./runtime-limits.js";

export type ContainerRuntimeSpec = {
  name: string;
  image: string;
  workingDirectory: "/app";
  mounts: [{ source: string; target: "/app"; readOnly: true }];
  command: ["npm", "start"];
  environment: Record<string, string>;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  user: "10001:10001";
  readOnlyRootFilesystem: true;
  capDrop: ["ALL"];
  securityOpt: ["no-new-privileges:true"];
  network: "dsquare-hosting-internal";
  tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" };
  restartPolicy: "unless-stopped";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_NODE_IMAGE = "node:22-bookworm-slim";
const PLATFORM_DATABASE_ENVIRONMENT_NAMES = new Set([
  "D_DATABASE_URL",
  "D_DATABASE_HOST",
  "D_DATABASE_PORT",
  "D_DATABASE_NAME",
  "D_DATABASE_USER",
  "D_DATABASE_PASSWORD",
  "D_DATABASE_SCHEMA",
  "D_DATABASE_PROJECT_ID",
  "D_DATABASE_RESOURCE_ID",
]);

/**
 * Creates a deterministic, restrictive container specification.
 * This function does not contact Docker or execute customer code.
 */
export function buildNodeContainerSpec(input: {
  resourceId: string;
  validation: NodeProjectValidation;
  artifactDirectory: string;
  environment: Record<string, string>;
  processEnvironment?: NodeJS.ProcessEnv;
}): ContainerRuntimeSpec {
  if (!UUID_PATTERN.test(input.resourceId)) {
    throw new Error("A valid website resource ID is required.");
  }
  if (!input.validation.valid) {
    throw new Error("A valid Node.js project is required before preparing a runtime.");
  }

  for (const [name, value] of Object.entries(input.environment)) {
    const validName = isValidEnvironmentName(name) ||
      PLATFORM_DATABASE_ENVIRONMENT_NAMES.has(name);
    if (!validName || typeof value !== "string" || value.length > 16384) {
      throw new Error("Runtime environment contains an invalid, reserved, or oversized variable.");
    }
  }

  if (!path.isAbsolute(input.artifactDirectory)) {
    throw new Error("A prepared absolute runtime artifact directory is required.");
  }

  const limits = getRuntimeLimits(input.processEnvironment);
  const configuredImage = input.processEnvironment?.HOSTING_NODE_RUNTIME_IMAGE?.trim();
  const image = configuredImage || DEFAULT_NODE_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{2,255}$/.test(image)) {
    throw new Error("HOSTING_NODE_RUNTIME_IMAGE is not a valid trusted image reference.");
  }

  return {
    name: `dsquare-site-${input.resourceId}`,
    image,
    workingDirectory: "/app",
    mounts: [{ source: input.artifactDirectory, target: "/app", readOnly: true }],
    command: ["npm", "start"],
    // PORT is platform-owned and deliberately injected only into the isolated process.
    environment: { ...input.environment, PORT: "3000" },
    memoryBytes: limits.memoryBytes,
    nanoCpus: limits.nanoCpus,
    pidsLimit: limits.pidsLimit,
    user: "10001:10001",
    readOnlyRootFilesystem: true,
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    network: "dsquare-hosting-internal",
    tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
    restartPolicy: "unless-stopped",
  };
}
