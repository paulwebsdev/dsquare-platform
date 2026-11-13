import assert from "node:assert/strict";
import test from "node:test";
import { expandIngressRoutes, getApiSubdomainConfig } from "./api-subdomain-routing.js";

const first = {
  domain: "www.example.com",
  resourceId: "11111111-1111-4111-8111-111111111111",
  deploymentId: "22222222-2222-4222-8222-222222222222",
};

test("derives an API subdomain and CNAME target from a website hostname", () => {
  assert.deepEqual(getApiSubdomainConfig("www.example.com"), {
    domain: "api.example.com",
    dnsTarget: "example.com",
  });
  assert.deepEqual(getApiSubdomainConfig("shop.example.com"), {
    domain: "api.shop.example.com",
    dnsTarget: "shop.example.com",
  });
  assert.deepEqual(getApiSubdomainConfig("example.com"), {
    domain: "api.example.com",
    dnsTarget: "example.com",
  });
});

test("rejects malformed hostnames and overlong derived API hostnames", () => {
  for (const value of ["", "https://example.com", "bad..example.com", "localhost", "a".repeat(250) + ".com"]) {
    assert.throws(() => getApiSubdomainConfig(value));
  }
});

test("adds deterministic API ingress routes to the same immutable deployment", () => {
  assert.deepEqual(expandIngressRoutes([first]), [
    { ...first, domain: "api.example.com" },
    first,
  ]);
});

test("fails closed when an API alias collides with another verified website domain", () => {
  assert.throws(() => expandIngressRoutes([
    first,
    {
      domain: "api.example.com",
      resourceId: "33333333-3333-4333-8333-333333333333",
      deploymentId: "44444444-4444-4444-8444-444444444444",
    },
  ]), /assigned more than once/);
});

test("rejects aliases already reserved by pending or static custom domains", () => {
  assert.throws(() => expandIngressRoutes([first], ["api.example.com"]), /already reserved/);
});
