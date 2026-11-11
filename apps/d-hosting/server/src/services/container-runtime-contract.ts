import type { NodeProjectValidation } from "./node-project-validation.js";
import { getRuntimeLimits } from "./runtime-limits.js";

export type ContainerRuntimeSpec = {
  name: string;
  image: string;
  workingDirectory: "/app";
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

/**
 * Creates a deterministic, restrictive container specification.
 * This function does not contact Docker or execute customer code.
 */
export function buildNodeContainerSpec(input: {
  resourceId: string;
  validation: NodeProjectValidation;
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new Error("Runtime environment contains an invalid variable.");
    }
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
    command: ["npm", "start"],
    // PORT is platform-owned and deliberately overrides any caller-supplied value.
    // The user-facing environment editor rejects PORT; this fixed value is injected
    // only into the isolated website process.
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
