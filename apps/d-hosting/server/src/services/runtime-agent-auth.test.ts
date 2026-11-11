import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import {
  RUNTIME_AGENT_MAX_CLOCK_SKEW_MS,
  signRuntimeAgentRequest,
  validateRuntimeAgentUrl,
} from "./runtime-agent-auth.js";

const secret = "0123456789abcdef0123456789abcdef";

test("signs method, path, timestamp, nonce, and exact body digest", () => {
  const body = JSON.stringify({ deploymentId: "deployment-1" });
  const headers = signRuntimeAgentRequest({
    method: "post",
    pathname: "/v1/runtimes",
    body,
    secret,
    now: 1_800_000_000_000,
    nonce: "123e4567-e89b-42d3-a456-426614174000",
  });
  const digest = createHash("sha256").update(body).digest("hex");
  const payload = [
    "POST",
    "/v1/runtimes",
    "1800000000000",
    "123e4567-e89b-42d3-a456-426614174000",
    digest,
  ].join("\n");
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  assert.equal(headers["x-dsquare-content-sha256"], digest);
  assert.equal(headers["x-dsquare-signature"], expected);
});

test("rejects weak secrets, malformed paths, methods, timestamps, and nonces", () => {
  assert.throws(() => signRuntimeAgentRequest({ method: "POST", pathname: "/", secret: "short" }), /32 bytes/);
  assert.throws(() => signRuntimeAgentRequest({ method: "POST", pathname: "//evil", secret }), /path is invalid/);
  assert.throws(() => signRuntimeAgentRequest({ method: "G", pathname: "/", secret }), /method is invalid/);
  assert.throws(() => signRuntimeAgentRequest({ method: "POST", pathname: "/", secret, now: 12 }), /timestamp is invalid/);
  assert.throws(() => signRuntimeAgentRequest({ method: "POST", pathname: "/", secret, nonce: "bad" }), /nonce is invalid/);
});

test("requires HTTPS and rejects URL credentials, query strings, and fragments", () => {
  assert.equal(validateRuntimeAgentUrl("https://runtime.example.com").protocol, "https:");
  assert.throws(() => validateRuntimeAgentUrl("http://runtime.example.com"), /HTTPS/);
  assert.throws(() => validateRuntimeAgentUrl("https://user:pass@runtime.example.com"), /without credentials/);
  assert.throws(() => validateRuntimeAgentUrl("https://runtime.example.com?token=x"), /without credentials/);
  assert.throws(() => validateRuntimeAgentUrl("https://runtime.example.com#fragment"), /without credentials/);
});

test("publishes a bounded clock-skew policy for the future agent verifier", () => {
  assert.equal(RUNTIME_AGENT_MAX_CLOCK_SKEW_MS, 5 * 60 * 1000);
});
