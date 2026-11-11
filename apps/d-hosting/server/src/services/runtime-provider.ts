import type { ContainerRuntimeSpec } from "./container-runtime-contract.js";
import type { RuntimeState } from "./runtime-lifecycle.js";

export type RuntimeInspection = {
  state: RuntimeState;
  containerId: string | null;
  startedAt: string | null;
  exitCode: number | null;
};

export type RuntimeLogEntry = {
  timestamp: string;
  stream: "stdout" | "stderr";
  message: string;
};

/**
 * Engine-independent adapter contract for an OCI container provider.
 * Podman is the preferred production engine; Docker-compatible adapters may be
 * used for development. Implementations must enforce the supplied isolation spec
 * and must not expose
 * the container socket or raw provider errors to website owners.
 */
export interface RuntimeProvider {
  start(spec: ContainerRuntimeSpec): Promise<{ containerId: string }>;
  stop(resourceId: string): Promise<void>;
  restart(spec: ContainerRuntimeSpec): Promise<{ containerId: string }>;
  inspect(resourceId: string): Promise<RuntimeInspection>;
  readLogs(resourceId: string, options?: { limit?: number }): Promise<RuntimeLogEntry[]>;
}

export function assertRuntimeProviderAvailable(
  provider: RuntimeProvider | null | undefined,
): asserts provider is RuntimeProvider {
  if (!provider) {
    throw new Error("Isolated runtime provider is not configured; customer code execution remains disabled.");
  }
}
