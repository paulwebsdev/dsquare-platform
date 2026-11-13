import path from "node:path";
import { PodmanApiClient, type PodmanTransport } from "./podman-client.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
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

  /** Fails closed unless the local Podman API is reachable over its Unix socket. */
  async checkAvailability(): Promise<void> {
    await this.client.ping();
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
        deploymentId: request.deploymentId,
        artifactId: request.artifactId,
        runtime: request.runtime,
        artifactDirectory,
        trustedImage: this.options.trustedImage,
        networkName: this.options.networkName,
      });
      containerId = await this.client.createContainer(config, request.runtime.name);
      await this.client.startContainer(containerId);
      return { containerId, workspacePath };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (containerId) {
        try {
          await this.client.removeContainer(containerId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await removeRuntimeWorkspace(this.options.runtimeRoot, request.artifactId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Runtime startup failed and rollback was incomplete.", { cause: error });
      }
      throw error;
    }
  }

  /** Adopt a container whose reservation survived a process crash, and remove only labelled DSquare orphans. */
  async reconcile(registry: RuntimeRegistry): Promise<{ adopted: number; removed: number }> {
    const containers = await this.client.listManagedContainers();
    let adopted = 0;
    let removed = 0;
    const seenContainerIds = new Set(containers.map((container) => container.id));
    for (const container of containers) {
      const record = await registry.get(container.resourceId);
      const identityMatches = record && record.deploymentId === container.deploymentId && record.artifactId === container.artifactId;
      if (identityMatches && record.containerId === container.id) continue;
      if (identityMatches && record.containerId === null && record.state === "creating") {
        if (await registry.complete(container.resourceId, container.id)) { adopted += 1; continue; }
      }
      await this.client.removeContainer(container.id);
      await removeRuntimeWorkspace(this.options.runtimeRoot, container.artifactId);
      removed += 1;
    }

    // A registry entry pointing to a container Podman no longer knows about
    // must not continue to advertise a healthy running/stopped runtime.
    for (const record of await registry.list()) {
      if (record.containerId && !seenContainerIds.has(record.containerId) &&
          (record.state === "running" || record.state === "stopped")) {
        await registry.setState(record.resourceId, "unknown");
      }
    }
    return { adopted, removed };
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
