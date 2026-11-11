import type { ContainerRuntimeSpec } from "./container-runtime-contract.js";
import { isValidEnvironmentName } from "./environment-secrets.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 2_000;

export type RuntimeArtifactDescriptor = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
};

export type RemoteRuntimeCreateRequest = {
  resourceId: string;
  deploymentId: string;
  artifact: RuntimeArtifactDescriptor;
  runtime: {
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
    tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" };
  };
};

/**
 * Converts the local runtime spec into a transport-safe request.
 * Host filesystem paths and local network names are deliberately never sent
 * to the remote agent; artifacts are transferred separately by artifactId.
 */
export function buildRemoteRuntimeCreateRequest(input: {
  resourceId: string;
  deploymentId: string;
  spec: ContainerRuntimeSpec;
  artifact: RuntimeArtifactDescriptor;
}): RemoteRuntimeCreateRequest {
  if (!UUID_PATTERN.test(input.resourceId) || !UUID_PATTERN.test(input.deploymentId) ||
      !UUID_PATTERN.test(input.artifact.artifactId)) {
    throw new Error("Valid website, deployment, and artifact IDs are required.");
  }
  if (!SHA256_PATTERN.test(input.artifact.sha256) ||
      !Number.isSafeInteger(input.artifact.sizeBytes) ||
      input.artifact.sizeBytes < 1 || input.artifact.sizeBytes > MAX_ARTIFACT_BYTES ||
      !Number.isInteger(input.artifact.fileCount) ||
      input.artifact.fileCount < 1 || input.artifact.fileCount > MAX_ARTIFACT_FILES) {
    throw new Error("Runtime artifact metadata is invalid or exceeds permitted limits.");
  }
  if (input.spec.name !== `dsquare-site-${input.resourceId}` ||
      input.spec.workingDirectory !== "/app" ||
      input.spec.command[0] !== "npm" || input.spec.command[1] !== "start" ||
      input.spec.mounts.length !== 1 || input.spec.mounts[0].target !== "/app" ||
      input.spec.mounts[0].readOnly !== true ||
      input.spec.user !== "10001:10001" ||
      input.spec.readOnlyRootFilesystem !== true ||
      input.spec.capDrop.length !== 1 || input.spec.capDrop[0] !== "ALL" ||
      input.spec.securityOpt.length !== 1 ||
      input.spec.securityOpt[0] !== "no-new-privileges:true") {
    throw new Error("Runtime specification does not meet the required isolation contract.");
  }
  if (!Number.isSafeInteger(input.spec.memoryBytes) || input.spec.memoryBytes < 64 * 1024 * 1024 ||
      !Number.isSafeInteger(input.spec.nanoCpus) || input.spec.nanoCpus < 100_000_000 ||
      !Number.isInteger(input.spec.pidsLimit) || input.spec.pidsLimit < 16 || input.spec.pidsLimit > 1024) {
    throw new Error("Runtime resource limits are invalid.");
  }
  for (const [name, value] of Object.entries(input.spec.environment)) {
    if (!isValidEnvironmentName(name) || typeof value !== "string" || value.length > 16384) {
      throw new Error("Runtime environment contains an invalid variable.");
    }
  }
  if (input.spec.environment.PORT !== "3000") {
    throw new Error("Runtime PORT must be platform-controlled.");
  }

  return {
    resourceId: input.resourceId,
    deploymentId: input.deploymentId,
    artifact: { ...input.artifact },
    runtime: {
      name: input.spec.name,
      image: input.spec.image,
      workingDirectory: "/app",
      command: ["npm", "start"],
      environment: { ...input.spec.environment },
      memoryBytes: input.spec.memoryBytes,
      nanoCpus: input.spec.nanoCpus,
      pidsLimit: input.spec.pidsLimit,
      user: "10001:10001",
      readOnlyRootFilesystem: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
    },
  };
}
