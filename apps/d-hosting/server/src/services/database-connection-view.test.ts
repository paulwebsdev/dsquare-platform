import assert from "node:assert/strict";
import test from "node:test";
import { toPublicDatabaseConnection } from "./database-connection-view.js";

test("public connection view excludes every database credential field", () => {
  const result = toPublicDatabaseConnection({
    id: "connection-1",
    database_project_id: "project-1",
    database_resource_id: "resource-1",
    resource_name: "Customer Data",
    status: "active",
    connected_at: "2026-11-11T00:00:00.000Z",
    database_host: "private.internal",
    database_port: 5432,
    database_name: "app_db",
    database_role_name: "dsq_app_secret",
    database_password_ciphertext: "ciphertext",
    database_password_iv: "iv",
    database_password_auth_tag: "tag",
    database_password: "plaintext",
  });

  assert.deepEqual(result, {
    id: "connection-1",
    database_project_id: "project-1",
    database_resource_id: "resource-1",
    resource_name: "Customer Data",
    status: "active",
    connected_at: "2026-11-11T00:00:00.000Z",
  });
  for (const key of Object.keys(result)) {
    assert.doesNotMatch(key, /password|ciphertext|database_host|database_role|database_port|database_name/);
  }
});

test("public connection view preserves revoked metadata and omits unknown fields", () => {
  const result = toPublicDatabaseConnection({
    id: "connection-2",
    status: "revoked",
    revoked_at: "2026-11-11T01:00:00.000Z",
    secret: "must-not-leak",
  });

  assert.deepEqual(result, {
    id: "connection-2",
    status: "revoked",
    revoked_at: "2026-11-11T01:00:00.000Z",
  });
});
