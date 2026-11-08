import assert from "node:assert/strict";
import test from "node:test";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { buildRuntimeEnvironment } from "./runtime-environment.js";

const environment = {
  HOSTING_SECRETS_KEY: Buffer.alloc(32, 11).toString("base64"),
};

test("decrypts variables only for their owning resource", () => {
  const encrypted = encryptEnvironmentSecret("postgres://private", environment, "resource-a:DATABASE_URL");
  const variables = [{ name: "DATABASE_URL", ...encrypted }];
  assert.deepEqual(
    buildRuntimeEnvironment("resource-a", variables, environment),
    Object.assign(Object.create(null), { DATABASE_URL: "postgres://private" }),
  );
  assert.throws(() => buildRuntimeEnvironment("resource-b", variables, environment), /authenticate|Unsupported state/i);
});

test("does not allow reserved names or duplicate variables into a runtime", () => {
  const secret = encryptEnvironmentSecret("value", environment, "resource-a:SAFE_VALUE");
  assert.throws(
    () => buildRuntimeEnvironment("resource-a", [{ name: "PORT", ...secret }], environment),
    /invalid or reserved/,
  );
  assert.throws(
    () => buildRuntimeEnvironment("resource-a", [
      { name: "SAFE_VALUE", ...secret },
      { name: "SAFE_VALUE", ...secret },
    ], environment),
    /duplicate/,
  );
});

test("returns an empty environment when no secrets are configured", () => {
  assert.deepEqual(buildRuntimeEnvironment("resource-a", [], environment), Object.create(null));
});
