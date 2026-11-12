import { decryptEnvironmentSecret } from "./environment-secrets.js";
import type { DatabaseConnectionCredentials } from "./database-connection-credentials.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA = /^db_[0-9a-f]{32}$/;
const ROLE = /^dsq_app_[0-9a-f]{32}$/;

/**
 * Converts one owner-approved, resource-scoped D Database connection into
 * backend-only environment variables. Never return this object from an API
 * route or log its values.
 */
export function buildDatabaseRuntimeEnvironment(input: {
  hostingUserId: string;
  connection: Omit<DatabaseConnectionCredentials, "database_password"> & {
    database_password_ciphertext: string;
    database_password_iv: string;
    database_password_auth_tag: string;
  };
  processEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { connection } = input;
  if (!UUID.test(input.hostingUserId) || !UUID.test(connection.user_id) ||
      input.hostingUserId !== connection.user_id ||
      !UUID.test(connection.project_id) || !UUID.test(connection.resource_id) ||
      !SCHEMA.test(connection.schema_name) || !ROLE.test(connection.database_role) ||
      !connection.database_host || connection.database_host.length > 253 ||
      /[\s\u0000-\u001f\u007f\\/?#@]/.test(connection.database_host) ||
      !Number.isInteger(connection.database_port) || connection.database_port < 1 ||
      connection.database_port > 65535 ||
      !/^[A-Za-z0-9_]{1,63}$/.test(connection.database_name)) {
    throw new Error("D Database connection is not valid for this Hosting account.");
  }

  const password = decryptEnvironmentSecret({
    ciphertext: connection.database_password_ciphertext,
    iv: connection.database_password_iv,
    authTag: connection.database_password_auth_tag,
  }, input.processEnvironment, `d-database:${input.hostingUserId}:${connection.resource_id}`);

  const encode = encodeURIComponent;
  const databaseUrl = `postgresql://${encode(connection.database_role)}:${encode(password)}@${connection.database_host}:${connection.database_port}/${encode(connection.database_name)}`;

  return {
    D_DATABASE_URL: databaseUrl,
    D_DATABASE_HOST: connection.database_host,
    D_DATABASE_PORT: String(connection.database_port),
    D_DATABASE_NAME: connection.database_name,
    D_DATABASE_USER: connection.database_role,
    D_DATABASE_PASSWORD: password,
    D_DATABASE_SCHEMA: connection.schema_name,
    D_DATABASE_PROJECT_ID: connection.project_id,
    D_DATABASE_RESOURCE_ID: connection.resource_id,
  };
}
