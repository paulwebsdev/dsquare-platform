export type DatabaseConnectionCredentials = {
  user_id: string;
  project_id: string;
  resource_id: string;
  resource_name: string;
  schema_name: string;
  database_host: string;
  database_port: number;
  database_name: string;
  database_role: string;
  database_password: string;
  database_connection_limit: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA = /^db_[0-9a-f]{32}$/;
const ROLE = /^dsq_app_[0-9a-f]{32}$/;
const DATABASE = /^[A-Za-z0-9_]{1,63}$/;
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;

export function isValidDatabaseConnectionCredentials(
  value: unknown,
): value is DatabaseConnectionCredentials {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.user_id === "string" && UUID.test(item.user_id) &&
    typeof item.project_id === "string" && UUID.test(item.project_id) &&
    typeof item.resource_id === "string" && UUID.test(item.resource_id) &&
    typeof item.resource_name === "string" &&
    item.resource_name.trim().length > 0 &&
    typeof item.schema_name === "string" && SCHEMA.test(item.schema_name) &&
    typeof item.database_host === "string" &&
    item.database_host.length <= 253 &&
    item.database_host.trim() === item.database_host &&
    !/[\s\u0000-\u001f\u007f\\/?#@]/.test(item.database_host) &&
    item.database_host.length > 0 &&
    Number.isInteger(item.database_port) &&
    Number(item.database_port) >= 1 && Number(item.database_port) <= 65535 &&
    typeof item.database_name === "string" && DATABASE.test(item.database_name) &&
    typeof item.database_role === "string" && ROLE.test(item.database_role) &&
    typeof item.database_password === "string" && PASSWORD.test(item.database_password) &&
    Number.isInteger(item.database_connection_limit) &&
    Number(item.database_connection_limit) >= 1 && Number(item.database_connection_limit) <= 50
  );
}
