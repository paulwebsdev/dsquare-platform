import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createRateLimiter } from "./rate-limit.js";

function sendRequest(limiter: ReturnType<typeof createRateLimiter>, ip = "192.0.2.1") {
  let statusCode = 200;
  let body: unknown;
  let nextCalled = false;
  const headers: Record<string, string> = {};

  const req = {
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as Response;

  limiter(req, res, () => {
    nextCalled = true;
  });

  return { statusCode, body, headers, nextCalled };
}

test("allows requests within the configured limit", () => {
  const limiter = createRateLimiter(2, 60_000);

  const first = sendRequest(limiter);
  const second = sendRequest(limiter);

  assert.equal(first.nextCalled, true);
  assert.equal(first.headers["RateLimit-Limit"], "2");
  assert.equal(first.headers["RateLimit-Remaining"], "1");
  assert.equal(second.nextCalled, true);
  assert.equal(second.headers["RateLimit-Remaining"], "0");
});

test("blocks excess requests with 429 and Retry-After", () => {
  const limiter = createRateLimiter(1, 60_000);

  sendRequest(limiter);
  const blocked = sendRequest(limiter);

  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["Retry-After"], "60");
  assert.deepEqual(blocked.body, {
    success: false,
    message: "Too many requests. Please try again later.",
  });
});

test("keeps request limits separate for different client IPs", () => {
  const limiter = createRateLimiter(1, 60_000);

  assert.equal(sendRequest(limiter, "192.0.2.1").nextCalled, true);
  assert.equal(sendRequest(limiter, "192.0.2.2").nextCalled, true);
  assert.equal(sendRequest(limiter, "192.0.2.1").statusCode, 429);
});

test("allows requests again after the window expires", async () => {
  const limiter = createRateLimiter(1, 20);

  assert.equal(sendRequest(limiter).nextCalled, true);
  assert.equal(sendRequest(limiter).statusCode, 429);

  await new Promise((resolve) => setTimeout(resolve, 30));

  const afterWindow = sendRequest(limiter);
  assert.equal(afterWindow.nextCalled, true);
  assert.equal(afterWindow.statusCode, 200);
});
