import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeProviderAvailable, type RuntimeProvider } from "./runtime-provider.js";

test("fails closed when no isolated runtime provider is configured", () => {
  assert.throws(() => assertRuntimeProviderAvailable(null), /execution remains disabled/);
  assert.throws(() => assertRuntimeProviderAvailable(undefined), /execution remains disabled/);
});

test("accepts a configured provider adapter", () => {
  const provider = {} as RuntimeProvider;
  assert.doesNotThrow(() => assertRuntimeProviderAvailable(provider));
});
