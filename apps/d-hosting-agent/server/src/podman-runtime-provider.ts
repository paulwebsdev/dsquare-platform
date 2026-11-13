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
  readinessTimeoutMs?: number;
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
    const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1_000 || readinessTimeoutMs > 120_000) {
      throw new Error("Runtime readiness timeout must be between 1 and 120 seconds.");
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
        deploymentId: request.deploymentId,
        artifactId: request.artifactId,
        runtime: request.runtime,
        artifactDirectory,
        trustedImage: this.options.trustedImage,
        networkName: this.options.networkName,
      });
      containerId = await this.client.createContainer(config, request.runtime.name);
      await this.client.startContainer(containerId);
      await this.waitForReadiness(containerId);
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

  /**
   * Do not report a deployment as started until its Node process accepts HTTP
   * traffic on the private container interface. A 4xx response still proves
   * the application is listening; 5xx, connection failures and timeouts retry.
   */
  private async waitForReadiness(containerId: string): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 30_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const execId = await this.client.createRuntimeReadinessExec(containerId);
        await this.client.startDetachedExec(execId);
        let status = await this.client.inspectExec(execId);
        while (status.running && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          status = await this.client.inspectExec(execId);
        }
        if (!status.running && status.exitCode === 0) return;
        lastError = new Error("Website did not accept a successful private HTTP readiness probe.");
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Website runtime did not become ready before the startup deadline.", { cause: lastError });
  }

  /** Adopt a container whose reservation survived a process crash, and remove only labelled DSquare orphans. */
  async reconcile(registry: RuntimeRegistry): Promise<{ adopted: number; removed: number }> {
    const containers = await this.client.listManagedContainers();
    let adopted = 0;
    let removed = 0;
    const seenContainerIds = new Set(containers.map((container) => container.id));
    for (const container of containers) {
      const record = await registry.getDeployment(container.deploymentId);
      const identityMatches = record && record.deploymentId === container.deploymentId && record.artifactId === container.artifactId;
      if (identityMatches && record.containerId === container.id) continue;
      if (identityMatches && record.containerId === null && record.state === "creating") {
        if (await registry.completeDeployment(container.deploymentId, container.id)) { adopted += 1; continue; }
      }
      await this.client.removeContainer(container.id);
      await removeRuntimeWorkspace(this.options.runtimeRoot, container.artifactId);
      removed += 1;
    }

    // A registry entry pointing to a container Podman no longer knows about
    // must not continue to advertise a healthy running/stopped runtime.
    for (const record of await registry.listDeployments()) {
      if (record.containerId && !seenContainerIds.has(record.containerId) &&
          (record.state === "running" || record.state === "stopped")) {
        await registry.setDeploymentState(record.deploymentId, "unknown");
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
    // A successful Podman restart only means the container process was relaunched.
    // Wait until the website is accepting private HTTP traffic before reporting success.
    await this.waitForReadiness(containerId);
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
