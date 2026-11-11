import assert from "node:assert/strict";
import test from "node:test";
import { getDatabaseApiUrl } from "./database-api-url.js";

test("allows the local D Database API during development", () => {
  assert.equal(getDatabaseApiUrl({ NODE_ENV: "development" }).origin, "http://127.0.0.1:5001");
  assert.equal(getDatabaseApiUrl({ NODE_ENV: "development", D_DATABASE_API_URL: "http://localhost:5001" }).origin, "http://localhost:5001");
});

test("requires HTTPS for non-loopback and production API URLs", () => {
  assert.equal(getDatabaseApiUrl({ NODE_ENV: "production", D_DATABASE_API_URL: "https://database.example.com" }).origin, "https://database.example.com");
  assert.throws(() => getDatabaseApiUrl({ NODE_ENV: "production", D_DATABASE_API_URL: "http://127.0.0.1:5001" }), /HTTPS/);
  assert.throws(() => getDatabaseApiUrl({ NODE_ENV: "development", D_DATABASE_API_URL: "http://database.internal:5001" }), /HTTPS/);
});

test("rejects credentials, query strings, and fragments in the API URL", () => {
  for (const value of [
    "https://user:pass@database.example.com",
    "https://database.example.com?token=secret",
    "https://database.example.com#fragment",
  ]) {
    assert.throws(() => getDatabaseApiUrl({ NODE_ENV: "production", D_DATABASE_API_URL: value }));
  }
});
