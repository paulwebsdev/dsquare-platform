import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_KIND,
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
  RESOURCE_LABEL,
} from "./product.js";

test("D Database dashboard identity is fixed and cannot fall back to Hosting", () => {
  assert.equal(PRODUCT_NAME, "D Database");
  assert.equal(PRODUCT_KIND, "database");
  assert.equal(RESOURCE_LABEL, "Databases");
  assert.match(PRODUCT_TAGLINE, /PostgreSQL databases/);
});
