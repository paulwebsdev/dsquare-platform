import assert from "node:assert/strict";
import test from "node:test";
import { redactRuntimeLogMessage, sanitizeRuntimeLogs } from "./runtime-logs.js";

test("redacts common secret assignments, bearer tokens, and database credentials", () => {
  const safe = redactRuntimeLogMessage(
    "password=hunter2 API_KEY:abc123 Bearer eyJhbGciOiJIUzI1NiJ9 postgres://user:pass@db.local/app",
  );
  assert.doesNotMatch(safe, /hunter2|abc123|eyJhbGci|user:pass/);
  assert.match(safe, /\\[REDACTED\\]/);
});

test("redacts platform secret-key and quoted environment assignments", () => {
  const safe = redactRuntimeLogMessage(
    'HOSTING_SECRETS_KEY=base64-private DATABASE_URL="postgres://private" PRIVATE_KEY:abc123 TOKEN=jwt-private',
  );
  assert.doesNotMatch(safe, /base64-private|postgres:\\/\\/private|abc123|jwt-private/);
  assert.equal((safe.match(/\\[REDACTED\\]/g) || []).length, 4);
});

test("limits log count and truncates excessively long messages", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    timestamp: new Date(index * 1000).toISOString(),
    stream: "stdout" as const,
    message: "x".repeat(5000),
  }));
  const safe = sanitizeRuntimeLogs(entries, 3);
  assert.equal(safe.length, 3);
  assert.equal(safe[0].message.length, 4000);
});

test("uses a safe default and maximum for requested log count", () => {
  const entries = Array.from({ length: 600 }, () => ({
    timestamp: new Date(0).toISOString(),
    stream: "stderr" as const,
    message: "error",
  }));
  assert.equal(sanitizeRuntimeLogs(entries, Number.NaN).length, 100);
  assert.equal(sanitizeRuntimeLogs(entries, 900).length, 500);
});
