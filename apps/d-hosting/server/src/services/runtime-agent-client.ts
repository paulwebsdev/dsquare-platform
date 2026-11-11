import {
  signRuntimeAgentRequest,
  validateRuntimeAgentUrl,
} from "./runtime-agent-auth.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type RuntimeAgentClientOptions = {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type RuntimeAgentRequestOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

/**
 * Sends one authenticated request to a remote Linux runtime agent.
 * It never follows redirects, bounds response size/time, and does not expose
 * response bodies in thrown errors. The agent must independently verify HMAC,
 * timestamp freshness, and nonce uniqueness.
 */
export async function requestRuntimeAgent<T>(
  options: RuntimeAgentClientOptions,
  request: RuntimeAgentRequestOptions,
): Promise<T> {
  const baseUrl = validateRuntimeAgentUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Runtime agent timeout must be between 1 and 60000 milliseconds.");
  }
  if (
    !/^\/v1\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(request.path) ||
    request.path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Runtime agent endpoint path is invalid.");
  }

  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  if (request.method === "GET" && body) {
    throw new Error("Runtime agent GET requests cannot include a body.");
  }
  const target = new URL(request.path, baseUrl);
  if (target.origin !== baseUrl.origin || !target.pathname.startsWith("/v1/")) {
    throw new Error("Runtime agent endpoint is outside the configured service.");
  }

  const headers = signRuntimeAgentRequest({
    method: request.method,
    pathname: target.pathname,
    body,
    secret: options.secret,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(target, {
    method: request.method,
    headers: {
      ...headers,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Runtime agent redirects are not permitted.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Runtime agent response exceeded the permitted size.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Runtime agent returned an empty response.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Runtime agent response exceeded the permitted size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) {
    throw new Error(`Runtime agent request failed with HTTP ${response.status}.`);
  }
  if (!raw) {
    throw new Error("Runtime agent returned an empty response.");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Runtime agent returned an invalid JSON response.");
  }
}

/**
 * Uploads one bounded binary artifact bundle using the same HMAC scheme as
 * JSON requests. The raw bytes are signed exactly as transmitted.
 */
export async function uploadRuntimeAgentArtifact(
  options: RuntimeAgentClientOptions,
  artifactId: string,
  bytes: Uint8Array,
): Promise<{ artifactId: string; accepted: boolean }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) {
    throw new Error("Runtime artifact ID is invalid.");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 100 * 1024 * 1024) {
    throw new Error("Runtime artifact upload must be between 1 byte and 100 MB.");
  }
  const baseUrl = validateRuntimeAgentUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Runtime agent timeout must be between 1 and 60000 milliseconds.");
  }
  const pathname = `/v1/artifacts/${artifactId}`;
  const target = new URL(pathname, baseUrl);
  if (target.origin !== baseUrl.origin) {
    throw new Error("Runtime agent endpoint is outside the configured service.");
  }
  const headers = signRuntimeAgentRequest({
    method: "PUT",
    pathname: target.pathname,
    body: bytes,
    secret: options.secret,
  });
  const response = await (options.fetchImpl ?? fetch)(target, {
    method: "PUT",
    headers: {
      ...headers,
      accept: "application/json",
      "content-type": "application/vnd.dsquare.runtime-artifact",
    },
    body: Buffer.from(bytes),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Runtime agent redirects are not permitted.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Runtime agent response exceeded the permitted size.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Runtime agent returned an empty upload response.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Runtime agent response exceeded the permitted size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) {
    throw new Error(`Runtime agent artifact upload failed with HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Runtime agent returned an invalid upload response.");
  }
  if (!parsed || typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).artifactId !== artifactId ||
      (parsed as Record<string, unknown>).accepted !== true) {
    throw new Error("Runtime agent did not confirm artifact acceptance.");
  }
  return parsed as { artifactId: string; accepted: true };
}


export type RuntimeAgentHealth = {
  status: "ready";
  providerConfigured: boolean;
  executionEnabled: boolean;
};

/** Checks the authenticated private agent endpoint without enabling deployments. */
export async function checkRuntimeAgentHealth(
  options: RuntimeAgentClientOptions,
): Promise<RuntimeAgentHealth> {
  const result = await requestRuntimeAgent<unknown>(options, {
    method: "GET",
    path: "/v1/health",
  });
  if (!result || typeof result !== "object" ||
      (result as Record<string, unknown>).status !== "ready" ||
      typeof (result as Record<string, unknown>).providerConfigured !== "boolean" ||
      typeof (result as Record<string, unknown>).executionEnabled !== "boolean") {
    throw new Error("Runtime agent returned an invalid health response.");
  }
  return result as RuntimeAgentHealth;
}
