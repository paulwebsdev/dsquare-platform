import path from "node:path";
import { PodmanApiClient, type PodmanTransport } from "./podman-client.js";
import { buildPodmanContainerConfig, type PodmanRuntimeInput } from "./podman-runtime-config.js";
import { materializeRuntimeWorkspace, removeRuntimeWorkspace } from "./runtime-workspace.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;

export type ManagedRuntimeRequest = {
  resourceId: string;
  deploymentId: string;
  artifactId: string;
  runtime: PodmanRuntimeInput;
};

export type PodmanRuntimeProviderOptions = {
  transport: PodmanTransport;
  storageRoot: string;
  runtimeRoot: string;
  trustedImage: string;
  networkName: string;
  /** Absolute Linux path visible to Podman for the workspace bind mount. */
  containerWorkspacePath?: (workspacePath: string, artifactId: string) => string;
};

/**
 * Owns the safe container lifecycle for one website deployment.
 * This provider is deliberately not enabled by the HTTP agent until Linux
 * configuration, persistence, and end-to-end checks are complete.
 */
export class PodmanRuntimeProvider {
  private readonly client: PodmanApiClient;
  private readonly options: PodmanRuntimeProviderOptions;

  constructor(options: PodmanRuntimeProviderOptions) {
    if (!options.trustedImage.trim() || !options.networkName.trim()) {
      throw new Error("Podman provider requires a trusted image and private network.");
    }
    this.client = new PodmanApiClient(options.transport);
    this.options = options;
  }

  async createAndStart(request: ManagedRuntimeRequest): Promise<{ containerId: string; workspacePath: string }> {
    if (!UUID.test(request.resourceId) || !UUID.test(request.deploymentId) ||
        !UUID.test(request.artifactId) || request.deploymentId !== request.artifactId) {
      throw new Error("Podman runtime deployment identity is invalid.");
    }

    const workspacePath = await materializeRuntimeWorkspace(
      this.options.storageRoot,
      request.artifactId,
      this.options.runtimeRoot,
    );
    let containerId: string | undefined;
    try {
      const artifactDirectory = this.options.containerWorkspacePath
        ? this.options.containerWorkspacePath(workspacePath, request.artifactId)
        : workspacePath;
      if (!path.posix.isAbsolute(artifactDirectory) || artifactDirectory.includes(":") ||
          /[\r\n\0]/.test(artifactDirectory)) {
        throw new Error("Podman workspace mount path must be a safe Linux absolute path.");
      }
      const config = buildPodmanContainerConfig({
        resourceId: request.resourceId,
        runtime: request.runtime,
        artifactDirectory,
        trustedImage: this.options.trustedImage,
        networkName: this.options.networkName,
      });
      containerId = await this.client.createContainer(config, request.runtime.name);
      await this.client.startContainer(containerId);
      return { containerId, workspacePath };
    } catch (error) {
      if (containerId) {
        await this.client.removeContainer(containerId).catch(() => undefined);
      }
      await removeRuntimeWorkspace(this.options.runtimeRoot, request.artifactId).catch(() => undefined);
      throw error;
    }
  }

  async stop(containerId: string): Promise<void> {
    this.assertContainerId(containerId);
    await this.client.stopContainer(containerId);
  }

  async restart(containerId: string): Promise<void> {
    this.assertContainerId(containerId);
    await this.client.restartContainer(containerId);
  }

  async inspect(containerId: string): Promise<Record<string, unknown>> {
    this.assertContainerId(containerId);
    return this.client.inspectContainer(containerId);
  }

  async logs(containerId: string, tail = 200): Promise<Buffer> {
    this.assertContainerId(containerId);
    return this.client.readContainerLogs(containerId, tail);
  }

  async remove(containerId: string, artifactId: string): Promise<boolean> {
    this.assertContainerId(containerId);
    if (!UUID.test(artifactId)) throw new Error("Runtime artifact ID is invalid.");
    await this.client.removeContainer(containerId);
    return removeRuntimeWorkspace(this.options.runtimeRoot, artifactId);
  }

  private assertContainerId(value: string): void {
    if (!CONTAINER_ID.test(value)) throw new Error("Podman container identifier is invalid.");
  }
}
