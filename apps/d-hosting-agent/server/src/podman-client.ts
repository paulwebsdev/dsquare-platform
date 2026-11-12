import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

export type PodmanResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export type PodmanRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

export type PodmanTransport = (request: PodmanRequest) => Promise<PodmanResponse>;

function safePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\r\n]/.test(value)) {
    throw new Error("Podman API path is invalid.");
  }
  return value;
}

/**
 * Private Unix-socket transport for the rootless/local Podman REST API.
 * It never accepts a TCP endpoint and never invokes a shell command.
 */
export function createPodmanSocketTransport(input: {
  socketPath: string;
  timeoutMs?: number;
}): PodmanTransport {
  if (!input.socketPath || !input.socketPath.startsWith("/")) {
    throw new Error("A Linux absolute Podman socket path is required.");
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("Podman API timeout is invalid.");
  }

  return (operation) => new Promise((resolve, reject) => {
    const pathname = safePath(operation.path);
    const requestTimeoutMs = operation.timeoutMs ?? timeoutMs;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 20 * 60 * 1000) {
      reject(new Error("Podman API request timeout is invalid."));
      return;
    }
    const body = operation.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(operation.body), "utf8");
    const req = httpRequest({
      socketPath: input.socketPath,
      path: pathname,
      method: operation.method,
      headers: {
        accept: "application/json",
        ...(body ? {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > 2 * 1024 * 1024) {
          req.destroy(new Error("Podman API response exceeded its limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error("Podman API request timed out.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export class PodmanApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "PodmanApiError";
  }
}



export type PodmanManagedContainer = {
  id: string;
  resourceId: string;
  deploymentId: string;
  artifactId: string;
};

export class PodmanApiClient {
  constructor(private readonly transport: PodmanTransport) {}

  private async call<T>(operation: PodmanRequest, allowed: number[]): Promise<T> {
    const response = await this.transport(operation);
    if (!allowed.includes(response.statusCode)) {
      let message = "Podman API request failed.";
      try {
        const decoded = JSON.parse(response.body.toString("utf8")) as { message?: unknown; cause?: unknown };
        if (typeof decoded.message === "string") message = decoded.message.slice(0, 500);
        else if (typeof decoded.cause === "string") message = decoded.cause.slice(0, 500);
      } catch {
        // Keep the generic message for non-JSON or untrusted responses.
      }
      throw new PodmanApiError(response.statusCode, message);
    }
    if (response.body.byteLength === 0) return undefined as T;
    try {
      return JSON.parse(response.body.toString("utf8")) as T;
    } catch {
      throw new Error("Podman API returned invalid JSON.");
    }
  }

  async listManagedContainers(): Promise<PodmanManagedContainer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["io.dsquare.managed=true"] }));
    const rows = await this.call<unknown>({
      method: "GET",
      path: `/v1.40/containers/json?all=true&filters=${filters}`,
    }, [200]);
    if (!Array.isArray(rows) || rows.length > 10_000) {
      throw new Error("Podman returned an invalid managed-container list.");
    }
    const managed: PodmanManagedContainer[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const item = row as Record<string, unknown>;
      const labels = item.Labels;
      if (!labels || typeof labels !== "object" || Array.isArray(labels)) continue;
      const values = labels as Record<string, unknown>;
      const id = item.Id;
      const resourceId = values["io.dsquare.resource-id"];
      const deploymentId = values["io.dsquare.deployment-id"];
      const artifactId = values["io.dsquare.artifact-id"];
      if (values["io.dsquare.managed"] !== "true" ||
          typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id) ||
          typeof resourceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resourceId) ||
          typeof deploymentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deploymentId) ||
          typeof artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) continue;
      managed.push({ id, resourceId, deploymentId, artifactId });
    }
    return managed;
  }

  async listManagedBuilderContainers(): Promise<Array<{ id: string; deploymentId: string }>> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["io.dsquare.builder=true"] }));
    const rows = await this.call<unknown>({
      method: "GET",
      path: `/v1.40/containers/json?all=true&filters=${filters}`,
    }, [200]);
    if (!Array.isArray(rows) || rows.length > 10_000) {
      throw new Error("Podman returned an invalid builder-container list.");
    }
    const managed: Array<{ id: string; deploymentId: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const item = row as Record<string, unknown>;
      if (!item.Labels || typeof item.Labels !== "object" || Array.isArray(item.Labels)) continue;
      const labels = item.Labels as Record<string, unknown>;
      if (labels["io.dsquare.builder"] !== "true") continue;
      if (typeof item.Id !== "string" || !/^[a-f0-9]{12,64}$/i.test(item.Id) ||
          typeof labels["io.dsquare.deployment-id"] !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labels["io.dsquare.deployment-id"])) {
        continue;
      }
      managed.push({ id: item.Id, deploymentId: labels["io.dsquare.deployment-id"] });
    }
    return managed;
  }

  async createContainer(config: Record<string, unknown>, name: string): Promise<string> {
    if (!/^dsquare-(?:site|builder)-[0-9a-f-]{36}$/i.test(name)) {
      throw new Error("Podman container name is invalid.");
    }
    const result = await this.call<{ Id?: unknown }>({
      method: "POST",
      path: `/v1.40/containers/create?name=${encodeURIComponent(name)}`,
      body: config,
    }, [201]);
    if (typeof result?.Id !== "string" || !/^[a-f0-9]{12,64}$/i.test(result.Id)) {
      throw new Error("Podman returned an invalid container identifier.");
    }
    return result.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.call({ method: "POST", path: `/v1.40/containers/${encodeURIComponent(id)}/start` }, [204, 304]);
  }

  async stopContainer(id: string): Promise<void> {
    await this.call({ method: "POST", path: `/v1.40/containers/${encodeURIComponent(id)}/stop?t=10` }, [204, 304, 404]);
  }

  async restartContainer(id: string): Promise<void> {
    await this.call({ method: "POST", path: `/v1.40/containers/${encodeURIComponent(id)}/restart?t=10` }, [204]);
  }

  async removeContainer(id: string): Promise<void> {
    await this.call({ method: "DELETE", path: `/v1.40/containers/${encodeURIComponent(id)}?force=true&v=false` }, [204, 404]);
  }

  async inspectContainer(id: string): Promise<Record<string, unknown>> {
    return this.call({ method: "GET", path: `/v1.40/containers/${encodeURIComponent(id)}/json` }, [200]);
  }

  async readContainerLogs(id: string, limit = 200): Promise<Buffer> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Podman log limit is invalid.");
    }
    const response = await this.transport({
      method: "GET",
      path: `/v1.40/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&timestamps=true&tail=${limit}`,
    });
    if (response.statusCode !== 200) {
      throw new PodmanApiError(response.statusCode, "Podman could not read runtime logs.");
    }
    if (response.body.byteLength > 1024 * 1024) {
      throw new Error("Podman runtime logs exceeded the permitted size.");
    }
    return response.body;
  }
  /** Create a detached exec for the two explicitly supported builder phases. */
  async createNodeBuildExec(containerId: string, phase: "install" | "build"): Promise<string> {
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error("Podman builder container identifier is invalid.");
    }
    const command = phase === "install"
      ? ["npm", "ci", "--offline", "--cache=/npm-cache", "--logs-dir=/tmp/npm-logs", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["npm", "run", "build", "--if-present", "--logs-dir=/tmp/npm-logs", "--ignore-scripts"];
    const result = await this.call<{ Id?: unknown }>({
      method: "POST",
      path: `/v1.40/containers/${encodeURIComponent(containerId)}/exec`,
      body: {
        Cmd: command,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: "/workspace",
        User: "10001:10001",
      },
    }, [201]);
    if (typeof result?.Id !== "string" || !/^[a-f0-9]{12,64}$/i.test(result.Id)) {
      throw new Error("Podman returned an invalid builder exec identifier.");
    }
    return result.Id;
  }

  /** Create a short-lived in-container HTTP probe without invoking a shell. */
  async createRuntimeReadinessExec(containerId: string): Promise<string> {
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error("Podman runtime container identifier is invalid.");
    }
    const script = "fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(1200),redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))";
    const result = await this.call<{ Id?: unknown }>({
      method: "POST",
      path: `/v1.40/containers/${encodeURIComponent(containerId)}/exec`,
      body: {
        Cmd: ["node", "-e", script],
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        WorkingDir: "/app",
        User: "10001:10001",
      },
    }, [201]);
    if (typeof result?.Id !== "string" || !/^[a-f0-9]{12,64}$/i.test(result.Id)) {
      throw new Error("Podman returned an invalid runtime readiness exec identifier.");
    }
    return result.Id;
  }

  async startDetachedExec(execId: string): Promise<void> {
    if (!/^[a-f0-9]{12,64}$/i.test(execId)) {
      throw new Error("Podman builder exec identifier is invalid.");
    }
    await this.call({
      method: "POST",
      path: `/v1.40/exec/${encodeURIComponent(execId)}/start`,
      body: { Detach: true, Tty: false },
    }, [200, 201, 204]);
  }

  /** Run an attached, non-TTY exec and return bounded stdout/stderr bytes. */
  async startAttachedExec(execId: string, maxOutputBytes = 2 * 1024 * 1024, timeoutMs = 10_000): Promise<Buffer> {
    if (!/^[a-f0-9]{12,64}$/i.test(execId) ||
        !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2 * 1024 * 1024 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15 * 60 * 1000) {
      throw new Error("Podman attached exec parameters are invalid.");
    }
    const response = await this.transport({
      method: "POST",
      path: `/v1.40/exec/${encodeURIComponent(execId)}/start`,
      body: { Detach: false, Tty: false },
      timeoutMs,
    });
    if (response.statusCode !== 200) {
      throw new PodmanApiError(response.statusCode, "Podman builder command could not start.");
    }
    if (response.body.byteLength > maxOutputBytes) {
      throw new Error("Podman builder output exceeded its permitted limit.");
    }
    // Docker-compatible multiplex framing: stream byte, three reserved bytes,
    // then a four-byte big-endian payload length.
    const output: Buffer[] = [];
    let offset = 0;
    while (offset < response.body.byteLength) {
      if (offset + 8 > response.body.byteLength) {
        throw new Error("Podman returned a truncated builder output frame.");
      }
      const stream = response.body[offset]!;
      const reserved = response.body.subarray(offset + 1, offset + 4);
      const length = response.body.readUInt32BE(offset + 4);
      if ((stream !== 1 && stream !== 2) || reserved.some((byte) => byte !== 0) ||
          length > maxOutputBytes || offset + 8 + length > response.body.byteLength) {
        throw new Error("Podman returned an invalid builder output frame.");
      }
      output.push(response.body.subarray(offset + 8, offset + 8 + length));
      offset += 8 + length;
    }
    return Buffer.concat(output);
  }

  async inspectExec(execId: string): Promise<{ running: boolean; exitCode: number | null }> {
    if (!/^[a-f0-9]{12,64}$/i.test(execId)) {
      throw new Error("Podman builder exec identifier is invalid.");
    }
    const result = await this.call<unknown>({
      method: "GET",
      path: `/v1.40/exec/${encodeURIComponent(execId)}/json`,
    }, [200]);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Podman returned an invalid builder exec status.");
    }
    const value = result as Record<string, unknown>;
    if (typeof value.Running !== "boolean" ||
        (value.ExitCode !== null && (!Number.isInteger(value.ExitCode) || (value.ExitCode as number) < 0))) {
      throw new Error("Podman returned an invalid builder exec status.");
    }
    return { running: value.Running, exitCode: value.ExitCode as number | null };
  }

}
