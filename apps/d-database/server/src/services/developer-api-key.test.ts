import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDeveloperApiKeyMaterial } from "./developer-api-key.js";

test("creates a high-entropy D Database API secret with a SHA-256 digest", () => {
  const material = createDeveloperApiKeyMaterial();
  assert.match(material.secret, /^dsq_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(material.prefix, material.secret.slice(0, 16));
  assert.match(material.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(material.tokenHash, createHash("sha256").update(material.secret).digest("hex"));
});

test("creates distinct secrets for separate API keys and rotations", () => {
  const first = createDeveloperApiKeyMaterial();
  const second = createDeveloperApiKeyMaterial();
  assert.notEqual(first.secret, second.secret);
  assert.notEqual(first.tokenHash, second.tokenHash);
});
