import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePrivateIngressDomain,
  renderPrivateIngressConfig,
} from "./private-ingress-config.js";

const resourceA = "11111111-1111-4111-8111-111111111111";
const resourceB = "22222222-2222-4222-8222-222222222222";

test("normalizes public internationalized hostnames and trailing dots", () => {
  assert.equal(normalizePrivateIngressDomain("WWW.Example.COM."), "www.example.com");
  assert.equal(normalizePrivateIngressDomain("bücher.example"), "xn--bcher-kva.example");
});

test("rejects private, local, malformed and non-hostname domain values", () => {
  for (const domain of [
    "", "localhost", "site.localhost", "site.local", "site.internal",
    "site.test", "site.example", "127.0.0.1", "[::1]", "example.com:443",
    "https://example.com", "*.example.com", "bad..example.com",
    "example.com/path", "example.com\\evil",
  ]) {
    assert.throws(() => normalizePrivateIngressDomain(domain), undefined, domain);
  }
});

test("renders deterministic private reverse-proxy routes with safe forwarded headers", () => {
  const config = renderPrivateIngressConfig([
    { domain: "www.example.com", resourceId: resourceB },
    { domain: "app.example.com", resourceId: resourceA },
  ], "ops@example.com");
  assert.ok(config.indexOf("app.example.com {") < config.indexOf("www.example.com {"));
  assert.match(config, /admin localhost:2019/);
  assert.match(config, /email ops@example.com/);
  assert.match(config, /dsquare-site-11111111-1111-4111-8111-111111111111\\.runtime\\.dsquare\\.internal:3000/);
  assert.match(config, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(config, /header_up -Forwarded/);
  assert.match(config, /header_up -X-Real-IP/);
  assert.match(config, /response_header_timeout 30s/);
  assert.match(config, /read_timeout 5m/);
  assert.match(config, /write_timeout 5m/);
  assert.equal(renderPrivateIngressConfig([
    { domain: "www.example.com", resourceId: resourceB },
    { domain: "app.example.com", resourceId: resourceA },
  ], "ops@example.com"), config);
});

test("rejects duplicate domains, invalid resource IDs and unsafe TLS contact emails", () => {
  assert.throws(() => renderPrivateIngressConfig([
    { domain: "example.com", resourceId: resourceA },
    { domain: "EXAMPLE.COM.", resourceId: resourceB },
  ]), /assigned more than once/);
  assert.throws(() => renderPrivateIngressConfig([
    { domain: "example.com", resourceId: "not-a-uuid" },
  ]), /resource ID is invalid/);
  assert.throws(() => renderPrivateIngressConfig([], "bad\\nheader@example.com"), /TLS contact email is invalid/);
});
