import { rm } from "node:fs/promises";
import {
  clearPreparedRuntimeEnvironment,
  prepareNodeRuntimeLaunch,
} from "./node-runtime-launch.js";
import { buildRemoteRuntimeCreateRequest } from "./runtime-agent-contract.js";
import {
  createRuntimeAgentRuntime,
  deleteRuntimeAgentArtifact,
  deleteRuntimeAgentRuntime,
  uploadRuntimeAgentArtifact,
  type RuntimeAgentClientOptions,
} from "./runtime-agent-client.js";
import { buildRuntimeArtifactBundle } from "./runtime-artifact-bundle.js";
import type { EncryptedEnvironmentVariable } from "./runtime-environment.js";
import type { NodeProjectValidation } from "./node-project-validation.js";
import type { NodeRuntimeSourceFile } from "./node-runtime-artifact.js";

export type StartRemoteNodeRuntimeInput = {
  resourceId: string;
  deploymentId: string;
  storageRoot: string;
  files: NodeRuntimeSourceFile[];
  validation: NodeProjectValidation;
  encryptedVariables: EncryptedEnvironmentVariable[];
  processEnvironment?: NodeJS.ProcessEnv;
  agent: RuntimeAgentClientOptions;
};

/**
 * Transfers a prepared deployment to the configured remote agent and asks it
 * to start the runtime. The local artifact is always removed after transfer;
 * customer code is never executed by the Hosting API process.
 *
 * This client-side flow remains unusable until a compatible authenticated
 * agent receiver and isolated OCI provider are deployed.
 */
export async function startRemoteNodeRuntime(
  input: StartRemoteNodeRuntimeInput,
): Promise<{ resourceId: string; deploymentId: string; artifactId: string; fileCount: number; state: "running" }> {
  const launch = await prepareNodeRuntimeLaunch(input);
  let artifactId: string | undefined;
  let artifactUploaded = false;

  try {
    artifactId = input.deploymentId;
    const bundle = await buildRuntimeArtifactBundle({
      artifactId,
      artifactDirectory: launch.artifactDirectory,
    });

    await uploadRuntimeAgentArtifact(input.agent, artifactId, bundle.bytes);
    artifactUploaded = true;

    const request = buildRemoteRuntimeCreateRequest({
      resourceId: input.resourceId,
      deploymentId: input.deploymentId,
      spec: launch.spec,
      artifact: bundle.descriptor,
    });

    const result = await createRuntimeAgentRuntime(input.agent, request);

    return {
      resourceId: result.resourceId,
      deploymentId: result.deploymentId,
      artifactId,
      fileCount: launch.fileCount,
      state: result.state,
    };
  } catch (error) {
    if (artifactUploaded && artifactId) {
      // A create response can be lost after the agent has already started the
      // container. Attempt runtime cleanup first, then remove the uploaded bundle.
      await deleteRuntimeAgentRuntime(input.agent, input.resourceId).catch(() => undefined);
      await deleteRuntimeAgentArtifact(input.agent, artifactId).catch(() => undefined);
    }
    throw error;
  } finally {
    clearPreparedRuntimeEnvironment(launch);
    await rm(launch.artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
