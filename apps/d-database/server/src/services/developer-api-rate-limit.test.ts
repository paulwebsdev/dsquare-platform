import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeDeveloperApiRateLimit,
  getDeveloperApiRateLimitConfig,
} from "./developer-api-rate-limit.js";

test("uses a bounded default per-key request limit", () => {
  assert.deepEqual(getDeveloperApiRateLimitConfig({}), {
    maxRequests: 300,
    windowMs: 60000,
  });
});

test("accepts configured request limits within safe bounds", () => {
  assert.deepEqual(getDeveloperApiRateLimitConfig({
    D_DATABASE_API_RATE_LIMIT_REQUESTS: "120",
    D_DATABASE_API_RATE_LIMIT_WINDOW_MS: "30000",
  }), {
    maxRequests: 120,
    windowMs: 30000,
  });
});

test("falls back to safe defaults for invalid rate-limit settings", () => {
  assert.deepEqual(getDeveloperApiRateLimitConfig({
    D_DATABASE_API_RATE_LIMIT_REQUESTS: "-1",
    D_DATABASE_API_RATE_LIMIT_WINDOW_MS: "999999999",
  }), {
    maxRequests: 300,
    windowMs: 60000,
  });
});

test("allows requests below the per-key limit and reports remaining capacity", async () => {
  let statement = "";
  let values: unknown[] = [];
  const result = await consumeDeveloperApiRateLimit({
    async query(sql, params) {
      statement = sql;
      values = params || [];
      return { rows: [{ request_count: 2, retry_after_seconds: 43 }] };
    },
  }, "11111111-1111-4111-8111-111111111111", { maxRequests: 3, windowMs: 60000 });

  assert.match(statement, /ON CONFLICT \(key_id\) DO UPDATE/);
  assert.deepEqual(values, ["11111111-1111-4111-8111-111111111111", 60000]);
  assert.deepEqual(result, { allowed: true, remaining: 1, retryAfterSeconds: 43, limit: 3 });
});

test("blocks requests after the per-key limit and returns a retry delay", async () => {
  const result = await consumeDeveloperApiRateLimit({
    async query() {
      return { rows: [{ request_count: 4, retry_after_seconds: 17 }] };
    },
  }, "11111111-1111-4111-8111-111111111111", { maxRequests: 3, windowMs: 60000 });

  assert.deepEqual(result, { allowed: false, remaining: 0, retryAfterSeconds: 17, limit: 3 });
});
