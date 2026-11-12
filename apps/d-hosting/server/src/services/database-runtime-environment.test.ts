import assert from "node:assert/strict";
import test from "node:test";
import { encryptEnvironmentSecret } from "./environment-secrets.js";
import { buildDatabaseRuntimeEnvironment } from "./database-runtime-environment.js";

const processEnvironment = { HOSTING_SECRETS_KEY: Buffer.alloc(32, 19).toString("base64") };
const hostingUserId = "11111111-1111-4111-8111-111111111111";
const connection = {
  user_id: hostingUserId,
  project_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "33333333-3333-4333-8333-333333333333",
  resource_name: "Customer Data",
  schema_name: "db_09800acba6c642d093f09d8aa73c2515",
  database_host: "database.internal",
  database_port: 5432,
  database_name: "d_database",
  database_role: "dsq_app_33333333333343338333333333333333",
  database_password: "secret-password-with-special-@-chars",
};

function encryptedConnection() {
  const encrypted = encryptEnvironmentSecret(
    connection.database_password,
    processEnvironment,
    `d-database:${hostingUserId}:${connection.resource_id}`,
  );
  return {
    ...connection,
    database_password_ciphertext: encrypted.ciphertext,
    database_password_iv: encrypted.iv,
    database_password_auth_tag: encrypted.authTag,
  };
}

test("creates backend-only D Database variables and an encoded connection URL", () => {
  const result = buildDatabaseRuntimeEnvironment({
    hostingUserId,
    connection: encryptedConnection(),
    processEnvironment,
  });
  assert.equal(result.D_DATABASE_HOST, "database.internal");
  assert.equal(result.D_DATABASE_SCHEMA, connection.schema_name);
  assert.equal(result.D_DATABASE_PASSWORD, connection.database_password);
  assert.match(result.D_DATABASE_URL, /%40/);
  assert.ok(!Object.values(result).includes(processEnvironment.HOSTING_SECRETS_KEY));
});

test("rejects a connection owned by another Hosting account", () => {
  assert.throws(() => buildDatabaseRuntimeEnvironment({
    hostingUserId,
    connection: { ...encryptedConnection(), user_id: "99999999-9999-4999-8999-999999999999" },
    processEnvironment,
  }), /not valid for this Hosting account/);
});

test("rejects unsafe endpoint and role details", () => {
  assert.throws(() => buildDatabaseRuntimeEnvironment({
    hostingUserId,
    connection: { ...encryptedConnection(), database_host: "database.internal/evil" },
    processEnvironment,
  }), /not valid/);
  assert.throws(() => buildDatabaseRuntimeEnvironment({
    hostingUserId,
    connection: { ...encryptedConnection(), database_role: "postgres" },
    processEnvironment,
  }), /not valid/);
});

test("rejects ciphertext copied from a different resource", () => {
  const encrypted = encryptEnvironmentSecret(
    connection.database_password,
    processEnvironment,
    "d-database:" + hostingUserId + ":44444444-4444-4444-8444-444444444444",
  );
  assert.throws(() => buildDatabaseRuntimeEnvironment({
    hostingUserId,
    connection: {
      ...connection,
      database_password_ciphertext: encrypted.ciphertext,
      database_password_iv: encrypted.iv,
      database_password_auth_tag: encrypted.authTag,
    },
    processEnvironment,
  }), /authenticate|Unsupported state/i);
});
