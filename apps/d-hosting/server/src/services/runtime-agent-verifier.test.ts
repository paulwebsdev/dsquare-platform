import assert from "node:assert/strict";
import test from "node:test";
import { signRuntimeAgentRequest } from "./runtime-agent-auth.js";
import {
  verifyRuntimeAgentRequest,
  type RuntimeAgentNonceStore,
} from "./runtime-agent-verifier.js";

const secret = "0123456789abcdef0123456789abcdef";
const now = 1_800_000_000_000;
const method = "POST";
const pathname = "/v1/runtimes";
const rawBody = JSON.stringify({ deploymentId: "deployment-1" });

class MemoryNonceStore implements RuntimeAgentNonceStore {
  private readonly used = new Set<string>();
  async claim(nonce: string): Promise<boolean> {
    if (this.used.has(nonce)) return false;
    this.used.add(nonce);
    return true;
  }
}

function signedHeaders(nonce = "123e4567-e89b-42d3-a456-426614174000") {
  return signRuntimeAgentRequest({ method, pathname, rawBody: undefined, body: rawBody, secret, now, nonce });
}

test("accepts a valid signed request and atomically claims its nonce", async () => {
  const nonceStore = new MemoryNonceStore();
  await assert.doesNotReject(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers: signedHeaders(), secret, nonceStore, now,
  }));
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers: signedHeaders(), secret, nonceStore, now,
  }), /already been used/);
});

test("rejects stale timestamps before claiming a nonce", async () => {
  const nonceStore = new MemoryNonceStore();
  const headers = signRuntimeAgentRequest({
    method, pathname, body: rawBody, secret, now: now - 10 * 60 * 1000,
  });
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers, secret, nonceStore, now,
  }), /timestamp/);
});

test("rejects body tampering and invalid signatures", async () => {
  const nonceStore = new MemoryNonceStore();
  const headers = signedHeaders();
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody: rawBody + " ", headers, secret, nonceStore, now,
  }), /body digest/);
  const badSignature = { ...headers, "x-dsquare-signature": "0".repeat(64) };
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers: badSignature, secret, nonceStore, now,
  }), /signature/);
});

test("rejects weak secrets and malformed authentication headers", async () => {
  const nonceStore = new MemoryNonceStore();
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers: signedHeaders(), secret: "weak", nonceStore, now,
  }), /not configured securely/);
  await assert.rejects(() => verifyRuntimeAgentRequest({
    method, pathname, rawBody, headers: {}, secret, nonceStore, now,
  }), /headers are invalid/);
});
