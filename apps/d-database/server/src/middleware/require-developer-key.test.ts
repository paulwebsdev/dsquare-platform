import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import {
  requireDeveloperKey,
  requireDeveloperScope,
} from "./require-developer-key.js";

function responseMock() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    locals: {} as Record<string, unknown>,
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  return { response, get statusCode() { return statusCode; }, get body() { return body; } };
}

test("rejects missing developer API authorization", async () => {
  const res = responseMock();
  let nextCalled = false;
  await requireDeveloperKey(
    { header: () => undefined, params: {} } as unknown as Request,
    res.response,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    success: false,
    message: "A valid D Database API key is required.",
  });
  assert.equal(nextCalled, false);
});

test("rejects malformed developer API authorization", async () => {
  const res = responseMock();
  let nextCalled = false;
  await requireDeveloperKey(
    { header: () => "Bearer not-a-database-key", params: {} } as unknown as Request,
    res.response,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("allows a scope explicitly granted to the key", () => {
  const res = responseMock();
  res.response.locals.developerKey = { scopes: ["read"] };
  let nextCalled = false;
  requireDeveloperScope("read")(
    {} as Request,
    res.response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
});

test("blocks a scope that was not granted to the key", () => {
  const res = responseMock();
  res.response.locals.developerKey = { scopes: ["read"] };
  let nextCalled = false;
  requireDeveloperScope("write")(
    {} as Request,
    res.response,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    message: "This API key does not have the write permission.",
  });
  assert.equal(nextCalled, false);
});

test("blocks requests when developer key context is missing", () => {
  const res = responseMock();
  let nextCalled = false;
  requireDeveloperScope("read")(
    {} as Request,
    res.response,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});
