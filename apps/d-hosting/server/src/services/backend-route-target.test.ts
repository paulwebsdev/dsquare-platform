import assert from "node:assert/strict";
import test from "node:test";
import { getBackendRouteTarget, isAllowedBackendPath } from "./backend-route-target.js";

const resourceId = "123e4567-e89b-42d3-a456-426614174000";

test("builds only deterministic internal upstream targets", () => {
  assert.equal(
    getBackendRouteTarget(resourceId),
    `http://dsquare-site-${resourceId}.runtime.dsquare.internal:3000`,
  );
  assert.throws(() => getBackendRouteTarget("not-a-uuid"), /Invalid website resource ID/);
  assert.throws(() => getBackendRouteTarget(resourceId, "localhost"), /internal DNS domain/);
  assert.throws(() => getBackendRouteTarget(resourceId, "127.0.0.1"), /internal DNS domain/);
});

test("allows safe API paths and rejects traversal or malformed paths", () => {
  assert.equal(isAllowedBackendPath("/api/students?page=1"), true);
  assert.equal(isAllowedBackendPath("/v1/health"), true);
  assert.equal(isAllowedBackendPath("//evil.example/path"), false);
  assert.equal(isAllowedBackendPath("/%2f%2fevil.example"), false);
  assert.equal(isAllowedBackendPath("/..%2fsecret"), false);
  assert.equal(isAllowedBackendPath("/bad\\path"), false);
  assert.equal(isAllowedBackendPath("/bad\u0000path"), false);
});
