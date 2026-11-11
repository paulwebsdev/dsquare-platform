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
