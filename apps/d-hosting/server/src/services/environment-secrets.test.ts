import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptEnvironmentSecret,
  encryptEnvironmentSecret,
  isValidEnvironmentName,
} from "./environment-secrets.js";

const environment = {
  HOSTING_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
};

test("encrypts and decrypts a secret without storing plaintext", () => {
  const value = "private-value-123";
  const encrypted = encryptEnvironmentSecret(value, environment, "resource-1:SECRET");
  assert.notEqual(encrypted.ciphertext, value);
  assert.equal(decryptEnvironmentSecret(encrypted, environment, "resource-1:SECRET"), value);
  assert.throws(() => decryptEnvironmentSecret(encrypted, environment, "another-resource:SECRET"), /authenticate|Unsupported state/i);
});

test("uses a fresh IV for each encryption", () => {
  const first = encryptEnvironmentSecret("same-value", environment);
  const second = encryptEnvironmentSecret("same-value", environment);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("rejects missing or incorrectly sized encryption keys", () => {
  assert.throws(() => encryptEnvironmentSecret("value", {}), /HOSTING_SECRETS_KEY/);
  assert.throws(
    () => encryptEnvironmentSecret("value", { HOSTING_SECRETS_KEY: Buffer.alloc(16).toString("base64") }),
    /32-byte key/,
  );
});

test("accepts safe environment names and rejects reserved or malformed names", () => {
  assert.equal(isValidEnvironmentName("PUBLIC_API_URL"), true);
  assert.equal(isValidEnvironmentName("1INVALID"), false);
  assert.equal(isValidEnvironmentName("NODE_OPTIONS"), false);
  assert.equal(isValidEnvironmentName("HOSTING_SECRETS_KEY"), false);
});
