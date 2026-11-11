import { createHash, createHmac, randomUUID } from "node:crypto";

export type RuntimeAgentRequestHeaders = {
  "x-dsquare-timestamp": string;
  "x-dsquare-nonce": string;
  "x-dsquare-content-sha256": string;
  "x-dsquare-signature": string;
};

const MINIMUM_SECRET_BYTES = 32;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalPath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\r\n]/.test(pathname)) {
    throw new Error("Runtime agent request path is invalid.");
  }
  return pathname;
}

function canonicalMethod(method: string): string {
  const normalized = method.toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(normalized)) {
    throw new Error("Runtime agent request method is invalid.");
  }
  return normalized;
}

function signingPayload(input: {
  method: string;
  pathname: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [
    canonicalMethod(input.method),
    canonicalPath(input.pathname),
    input.timestamp,
    input.nonce,
    input.bodyHash,
  ].join("\n");
}

/**
 * Creates HMAC authentication headers for a private Hosting-to-agent request.
 * The caller must send these headers over HTTPS and the agent must reject
 * reused nonces as well as timestamps outside the allowed clock-skew window.
 */
export function signRuntimeAgentRequest(input: {
  method: string;
  pathname: string;
  body?: string;
  secret: string;
  now?: number;
  nonce?: string;
}): RuntimeAgentRequestHeaders {
  const secret = Buffer.from(input.secret, "utf8");
  if (secret.byteLength < MINIMUM_SECRET_BYTES) {
    throw new Error("Runtime agent shared secret must contain at least 32 bytes.");
  }

  const timestamp = String(input.now ?? Date.now());
  if (!/^\d{13}$/.test(timestamp)) {
    throw new Error("Runtime agent request timestamp is invalid.");
  }
  const nonce = input.nonce ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) {
    throw new Error("Runtime agent request nonce is invalid.");
  }

  const bodyHash = createHash("sha256").update(input.body ?? "", "utf8").digest("hex");
  const payload = signingPayload({
    method: input.method,
    pathname: input.pathname,
    timestamp,
    nonce,
    bodyHash,
  });
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  return {
    "x-dsquare-timestamp": timestamp,
    "x-dsquare-nonce": nonce,
    "x-dsquare-content-sha256": bodyHash,
    "x-dsquare-signature": signature,
  };
}

/** Validates a configured remote agent URL; credentials and non-HTTPS URLs are forbidden. */
export function validateRuntimeAgentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Runtime agent URL must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Runtime agent URL must use HTTPS without credentials, query, or fragment.");
  }
  return url;
}

export const RUNTIME_AGENT_MAX_CLOCK_SKEW_MS = MAX_CLOCK_SKEW_MS;
