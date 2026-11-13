import assert from "node:assert/strict";
import test from "node:test";
import { buildWebsiteObjectKey } from "./website-object-storage.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  resourceId: "33333333-3333-4333-8333-333333333333",
  objectId: "44444444-4444-4444-8444-444444444444",
};

test("website object keys are scoped by owner, project, website, and immutable object ID", () => {
  assert.equal(
    buildWebsiteObjectKey(base),
    "owners/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/websites/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444",
  );
  assert.notEqual(
    buildWebsiteObjectKey({ ...base, ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    buildWebsiteObjectKey(base),
  );
  assert.notEqual(
    buildWebsiteObjectKey({ ...base, resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    buildWebsiteObjectKey(base),
  );
});

test("website object keys reject invalid identifiers", () => {
  assert.throws(() => buildWebsiteObjectKey({ ...base, ownerId: "../other-owner" }), /identity is invalid/);
  assert.throws(() => buildWebsiteObjectKey({ ...base, objectId: "not-a-uuid" }), /identity is invalid/);
});
