import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  isSupportedPasswordHash,
  verifyPassword,
} from "./password.js";

test("D Database password hashes verify only the password used to create them", async () => {
  const password = "correct horse battery staple";
  const hash = await hashPassword(password);

  assert.equal(isSupportedPasswordHash(hash), true);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("different password", hash), false);
});

test("D Database password hashes use unique salts", async () => {
  const first = await hashPassword("same password");
  const second = await hashPassword("same password");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same password", first), true);
  assert.equal(await verifyPassword("same password", second), true);
});

test("unsupported or malformed legacy hash formats are rejected safely", async () => {
  for (const hash of [
    "",
    "plain-text-password",
    "scrypt$v1$0123456789abcdef0123456789abcdef$" + "a".repeat(128),
    "dsquare-scrypt$v2$0123456789abcdef0123456789abcdef$" + "a".repeat(128),
    "dsquare-scrypt$v1$bad-salt$" + "a".repeat(128),
    "dsquare-scrypt$v1$0123456789abcdef0123456789abcdef$bad-key",
  ]) {
    assert.equal(isSupportedPasswordHash(hash), false);
    assert.equal(await verifyPassword("password", hash), false);
  }
});
