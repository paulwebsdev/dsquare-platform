import { rm } from "node:fs/promises";
import {
  buildNodeContainerSpec,
  type ContainerRuntimeSpec,
} from "./container-runtime-contract.js";
import {
  buildRuntimeEnvironment,
  type EncryptedEnvironmentVariable,
} from "./runtime-environment.js";
import {
  prepareNodeRuntimeArtifact,
  type NodeRuntimeSourceFile,
} from "./node-runtime-artifact.js";
import type { NodeProjectValidation } from "./node-project-validation.js";
import { buildDatabaseRuntimeEnvironment, type EncryptedDatabaseRuntimeConnection } from "./database-runtime-environment.js";

export type PreparedNodeRuntimeLaunch = {
  artifactDirectory: string;
  fileCount: number;
  spec: ContainerRuntimeSpec;
};

/**
 * Prepares a deployment for a trusted isolated provider. This function does not
 * start a process; callers must keep the spec internal and pass it only to the
 * configured RuntimeProvider.
 */
export async function prepareNodeRuntimeLaunch(input: {
  resourceId: string;
  deploymentId: string;
  storageRoot: string;
  files: NodeRuntimeSourceFile[];
  validation: NodeProjectValidation;
  encryptedVariables: EncryptedEnvironmentVariable[];
  databaseConnection?: EncryptedDatabaseRuntimeConnection;
  hostingUserId?: string;
  processEnvironment?: NodeJS.ProcessEnv;
}): Promise<PreparedNodeRuntimeLaunch> {
  if (!input.validation.valid) {
    throw new Error("A valid Node.js project is required before preparing a runtime.");
  }

  const artifact = await prepareNodeRuntimeArtifact({
    resourceId: input.resourceId,
    deploymentId: input.deploymentId,
    storageRoot: input.storageRoot,
    files: input.files,
  });

  try {
    const environment = buildRuntimeEnvironment(
      input.resourceId,
      input.encryptedVariables,
      input.processEnvironment,
    );
    const databaseEnvironment = input.databaseConnection
      ? buildDatabaseRuntimeEnvironment({
          hostingUserId: input.hostingUserId || "",
          connection: input.databaseConnection,
          processEnvironment: input.processEnvironment,
        })
      : {};
    const spec = buildNodeContainerSpec({
      resourceId: input.resourceId,
      validation: input.validation,
      artifactDirectory: artifact.directory,
      environment: { ...environment, ...databaseEnvironment },
      processEnvironment: input.processEnvironment,
    });

    return {
      artifactDirectory: artifact.directory,
      fileCount: artifact.fileCount,
      spec,
    };
  } catch (error) {
    await rm(artifact.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Call after the provider has accepted the spec. JavaScript strings cannot be
 * reliably zeroed, but removing references prevents accidental later reuse.
 */
export function clearPreparedRuntimeEnvironment(launch: PreparedNodeRuntimeLaunch): void {
  for (const name of Object.keys(launch.spec.environment)) {
    launch.spec.environment[name] = "";
    delete launch.spec.environment[name];
  }
}
