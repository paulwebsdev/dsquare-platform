import assert from "node:assert/strict";
import test from "node:test";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { buildRuntimeEnvironment } from "./runtime-environment.js";

const environment = {
  HOSTING_SECRETS_KEY: Buffer.alloc(32, 11).toString("base64"),
};
const resourceA = "123e4567-e89b-42d3-a456-426614174000";
const resourceB = "123e4567-e89b-42d3-a456-426614174001";

test("decrypts variables only for their owning resource", () => {
  const encrypted = encryptEnvironmentSecret("postgres://private", environment, `${resourceA}:DATABASE_URL`);
  const variables = [{ name: "DATABASE_URL", ...encrypted }];
  assert.deepEqual(
    buildRuntimeEnvironment(resourceA, variables, environment),
    Object.assign(Object.create(null), { DATABASE_URL: "postgres://private" }),
  );
  assert.throws(() => buildRuntimeEnvironment(resourceB, variables, environment), /authenticate|Unsupported state/i);
});

test("does not allow reserved names or duplicate variables into a runtime", () => {
  const secret = encryptEnvironmentSecret("value", environment, `${resourceA}:SAFE_VALUE`);
  assert.throws(
    () => buildRuntimeEnvironment(resourceA, [{ name: "PORT", ...secret }], environment),
    /invalid or reserved/,
  );
  assert.throws(
    () => buildRuntimeEnvironment(resourceA, [
      { name: "SAFE_VALUE", ...secret },
      { name: "SAFE_VALUE", ...secret },
    ], environment),
    /duplicate/,
  );
});

test("requires a valid resource UUID before decrypting secrets", () => {
  assert.throws(() => buildRuntimeEnvironment("resource-a", [], environment), /valid website resource ID/);
  assert.throws(() => buildRuntimeEnvironment("", [], environment), /valid website resource ID/);
});

test("returns an empty environment when no secrets are configured", () => {
  assert.deepEqual(buildRuntimeEnvironment(resourceA, [], environment), Object.create(null));
});
