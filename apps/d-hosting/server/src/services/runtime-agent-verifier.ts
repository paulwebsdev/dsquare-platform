import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { RUNTIME_AGENT_MAX_CLOCK_SKEW_MS } from "./runtime-agent-auth.js";

export type RuntimeAgentAuthHeaders = {
  "x-dsquare-timestamp"?: string;
  "x-dsquare-nonce"?: string;
  "x-dsquare-content-sha256"?: string;
  "x-dsquare-signature"?: string;
};

/**
 * Implementations must atomically claim a nonce until expiresAt.
 * A database unique constraint or Redis SET NX with TTL is suitable.
 */
export interface RuntimeAgentNonceStore {
  claim(nonce: string, expiresAt: number): Promise<boolean>;
}

export type VerifyRuntimeAgentRequestInput = {
  method: string;
  pathname: string;
  rawBody: string | Uint8Array;
  headers: RuntimeAgentAuthHeaders;
  secret: string;
  nonceStore: RuntimeAgentNonceStore;
  now?: number;
};

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * Verifies the exact request bytes before an agent performs any action.
 * The nonce store must provide an atomic claim to prevent concurrent replays.
 */
export async function verifyRuntimeAgentRequest(
  input: VerifyRuntimeAgentRequestInput,
): Promise<void> {
  if (Buffer.byteLength(input.secret, "utf8") < 32) {
    throw new Error("Runtime agent shared secret is not configured securely.");
  }
  if (!/^[A-Z]{3,10}$/.test(input.method) ||
      !input.pathname.startsWith("/") ||
      input.pathname.startsWith("//") ||
      /[\r\n]/.test(input.pathname)) {
    throw new Error("Runtime agent request target is invalid.");
  }

  const timestamp = input.headers["x-dsquare-timestamp"] ?? "";
  const nonce = input.headers["x-dsquare-nonce"] ?? "";
  const bodyHash = input.headers["x-dsquare-content-sha256"] ?? "";
  const signature = input.headers["x-dsquare-signature"] ?? "";
  if (!/^\d{13}$/.test(timestamp) ||
      !/^[0-9a-f-]{36}$/i.test(nonce) ||
      !/^[a-f0-9]{64}$/i.test(bodyHash) ||
      !/^[a-f0-9]{64}$/i.test(signature)) {
    throw new Error("Runtime agent authentication headers are invalid.");
  }

  const now = input.now ?? Date.now();
  const requestTime = Number(timestamp);
  if (!Number.isSafeInteger(now) ||
      Math.abs(now - requestTime) > RUNTIME_AGENT_MAX_CLOCK_SKEW_MS) {
    throw new Error("Runtime agent request timestamp is outside the permitted window.");
  }

  const actualBodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  if (!safeHexEqual(bodyHash, actualBodyHash)) {
    throw new Error("Runtime agent request body digest is invalid.");
  }

  const payload = [
    input.method,
    input.pathname,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const expectedSignature = createHmac("sha256", input.secret).update(payload, "utf8").digest("hex");
  if (!safeHexEqual(signature, expectedSignature)) {
    throw new Error("Runtime agent request signature is invalid.");
  }

  const claimed = await input.nonceStore.claim(
    nonce,
    requestTime + RUNTIME_AGENT_MAX_CLOCK_SKEW_MS,
  );
  if (!claimed) {
    throw new Error("Runtime agent request nonce has already been used.");
  }
}
