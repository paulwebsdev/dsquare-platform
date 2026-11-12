import { rm } from "node:fs/promises";
import {
  clearPreparedRuntimeEnvironment,
  prepareNodeRuntimeLaunch,
} from "./node-runtime-launch.js";
import type { EncryptedEnvironmentVariable } from "./runtime-environment.js";
import type { NodeProjectValidation } from "./node-project-validation.js";
import {
  assertRuntimeProviderAvailable,
  type RuntimeProvider,
} from "./runtime-provider.js";
import type { NodeRuntimeSourceFile } from "./node-runtime-artifact.js";
import type { EncryptedDatabaseRuntimeConnection } from "./database-runtime-environment.js";

export type StartNodeRuntimeInput = {
  resourceId: string;
  deploymentId: string;
  storageRoot: string;
  files: NodeRuntimeSourceFile[];
  validation: NodeProjectValidation;
  encryptedVariables: EncryptedEnvironmentVariable[];
  databaseConnection?: EncryptedDatabaseRuntimeConnection;
  hostingUserId?: string;
  processEnvironment?: NodeJS.ProcessEnv;
};

/**
 * Prepares and starts one website through an explicitly supplied isolated
 * provider. No host process execution or implicit provider discovery occurs.
 */
export async function startNodeRuntime(
  input: StartNodeRuntimeInput,
  provider: RuntimeProvider | null | undefined,
): Promise<{ containerId: string; artifactDirectory: string; fileCount: number }> {
  assertRuntimeProviderAvailable(provider);

  const launch = await prepareNodeRuntimeLaunch(input);
  try {
    const started = await provider.start(launch.spec);
    if (!started || typeof started.containerId !== "string" || !started.containerId.trim()) {
      throw new Error("The isolated runtime provider returned an invalid instance identifier.");
    }

    return {
      containerId: started.containerId,
      artifactDirectory: launch.artifactDirectory,
      fileCount: launch.fileCount,
    };
  } catch (error) {
    await rm(launch.artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearPreparedRuntimeEnvironment(launch);
  }
}
