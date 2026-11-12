import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  clearPreparedRuntimeEnvironment,
  prepareNodeRuntimeLaunch,
} from "./node-runtime-launch.js";
import { buildRemoteRuntimeCreateRequest } from "./runtime-agent-contract.js";
import {
  buildRuntimeAgentArtifact,
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
import { getAssignedDatabaseRuntimeConnection } from "./assigned-database-runtime-connection.js";

export type StartRemoteNodeRuntimeInput = {
  resourceId: string;
  deploymentId: string;
  storageRoot: string;
  files: NodeRuntimeSourceFile[];
  validation: NodeProjectValidation;
  encryptedVariables: EncryptedEnvironmentVariable[];
  hostingUserId: string;
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
  loadAssignedConnection: typeof getAssignedDatabaseRuntimeConnection = getAssignedDatabaseRuntimeConnection,
): Promise<{ resourceId: string; deploymentId: string; artifactId: string; fileCount: number; state: "running" }> {
  const databaseConnection = await loadAssignedConnection({
    hostingUserId: input.hostingUserId,
    resourceId: input.resourceId,
  });
  const launch = await prepareNodeRuntimeLaunch({
    ...input,
    ...(databaseConnection ? { databaseConnection, hostingUserId: input.hostingUserId } : {}),
  });
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


/**
 * Complete remote Node deployment pipeline: stage immutable source files,
 * transfer them to the private agent, build in the isolated builder, start the
 * resulting immutable runtime artifact, then remove the temporary source copy.
 * Runtime activation in the Hosting database is deliberately a separate step
 * performed only after this function confirms readiness.
 */
export async function startBuiltRemoteNodeRuntime(
  input: StartRemoteNodeRuntimeInput,
  loadAssignedConnection: typeof getAssignedDatabaseRuntimeConnection = getAssignedDatabaseRuntimeConnection,
): Promise<{
  resourceId: string;
  deploymentId: string;
  artifactId: string;
  fileCount: number;
  state: "running";
  buildOutput: string;
}> {
  const databaseConnection = await loadAssignedConnection({
    hostingUserId: input.hostingUserId,
    resourceId: input.resourceId,
  });
  const launch = await prepareNodeRuntimeLaunch({
    ...input,
    ...(databaseConnection ? { databaseConnection, hostingUserId: input.hostingUserId } : {}),
  });
  const sourceArtifactId = randomUUID();
  let sourceUploaded = false;
  let builtArtifactCreated = false;
  let runtimeCreated = false;
  try {
    const sourceBundle = await buildRuntimeArtifactBundle({
      artifactId: sourceArtifactId,
      artifactDirectory: launch.artifactDirectory,
    });
    await uploadRuntimeAgentArtifact(input.agent, sourceArtifactId, sourceBundle.bytes);
    sourceUploaded = true;

    const built = await buildRuntimeAgentArtifact(input.agent, {
      sourceArtifactId,
      deploymentId: input.deploymentId,
    });
    builtArtifactCreated = true;

    const request = buildRemoteRuntimeCreateRequest({
      resourceId: input.resourceId,
      deploymentId: input.deploymentId,
      spec: launch.spec,
      artifact: built.artifact,
    });
    const started = await createRuntimeAgentRuntime(input.agent, request);
    runtimeCreated = true;

    return {
      resourceId: started.resourceId,
      deploymentId: started.deploymentId,
      artifactId: built.artifact.artifactId,
      fileCount: built.artifact.fileCount,
      state: started.state,
      buildOutput: built.output,
    };
  } catch (error) {
    if (runtimeCreated) {
      await deleteRuntimeAgentRuntime(input.agent, input.resourceId).catch(() => undefined);
    }
    if (builtArtifactCreated) {
      await deleteRuntimeAgentArtifact(input.agent, input.deploymentId).catch(() => undefined);
    }
    throw error;
  } finally {
    if (sourceUploaded) {
      await deleteRuntimeAgentArtifact(input.agent, sourceArtifactId).catch(() => undefined);
    }
    clearPreparedRuntimeEnvironment(launch);
    await rm(launch.artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
