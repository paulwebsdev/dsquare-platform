import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPrivateIngressConfig,
  normalizeIngressHostname,
  renderPrivateIngressJsonConfig,
} from "./private-ingress-controller.js";

const resourceId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";

test("normalizes public IDN hostnames and rejects non-public hostnames", () => {
  assert.equal(normalizeIngressHostname("WWW.Example.COM."), "www.example.com");
  assert.equal(normalizeIngressHostname("bücher.com"), "xn--bcher-kva.com");
  for (const value of ["localhost", "site.local", "127.0.0.1", "999.1.1.1",
    "https://example.com", "example.com:443", "*.example.com", "bad..example.com"]) {
    assert.throws(() => normalizeIngressHostname(value));
  }
});

test("renders deterministic Caddy JSON routes to deployment-private aliases", () => {
  const config = renderPrivateIngressJsonConfig([
    { domain: "www.example.com", resourceId, deploymentId },
  ], "ops@example.com");
  const serialized = JSON.stringify(config);
  assert.deepEqual((config as { admin: { listen: string } }).admin, { listen: "0.0.0.0:2019" });
  assert.ok(serialized.includes("dsquare-deploy-" + deploymentId + ".runtime.dsquare.internal:3000"));
  assert.ok(serialized.includes("X-Forwarded-For"));
  assert.ok(serialized.includes("Forwarded"));
  assert.ok(serialized.includes("ops@example.com"));
  assert.ok(serialized.includes(":80"));
  assert.ok(serialized.includes(":443"));
  assert.throws(() => renderPrivateIngressJsonConfig([
    { domain: "example.com", resourceId, deploymentId },
    { domain: "EXAMPLE.COM.", resourceId, deploymentId },
  ]), /assigned more than once/);
  assert.throws(() => renderPrivateIngressJsonConfig([], "bad{email}@example.com"), /TLS contact email/);
});

test("only applies Caddy configuration through a loopback admin endpoint", async () => {
  let requested = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requested = true;
    assert.equal(String(url), "http://127.0.0.1:2019/load");
    assert.equal(init?.method, "POST");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await applyPrivateIngressConfig({
    adminUrl: "http://127.0.0.1:2019/",
    config: renderPrivateIngressJsonConfig([]),
    fetchImpl,
  });
  assert.equal(requested, true);
  for (const adminUrl of [
    "http://example.com:2019/",
    "https://127.0.0.1:2019/",
    "http://127.0.0.1:2019/other",
    "http://user:pass@127.0.0.1:2019/",
  ]) {
    await assert.rejects(applyPrivateIngressConfig({
      adminUrl, config: renderPrivateIngressJsonConfig([]), fetchImpl,
    }));
  }
});

test("fails closed when Caddy rejects a route update", async () => {
  await assert.rejects(applyPrivateIngressConfig({
    adminUrl: "http://localhost:2019/",
    config: renderPrivateIngressJsonConfig([]),
    fetchImpl: (async () => new Response(null, { status: 400 })) as typeof fetch,
  }), /Caddy rejected/);
});
