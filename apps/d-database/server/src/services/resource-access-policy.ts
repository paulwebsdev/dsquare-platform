import { randomBytes } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA_PATTERN = /^db_[0-9a-f]{32}$/;
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export type ResourceAccessPlan = {
  roleName: string;
  password: string;
  createRole: string;
  grantStatements: string[];
  configureStatements: string[];
  disableRole: string;
};

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error("Invalid PostgreSQL identifier.");
  }
  return `"${value}"`;
}

/**
 * Builds a least-privilege login plan for exactly one D Database schema.
 * Execute only through the separately configured provisioner connection.
 */
export function createResourceAccessPlan(input: {
  resourceId: string;
  schemaName: string;
  databaseName: string;
  schemaOwner: string;
  limits?: {
    connectionLimit: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionSessionTimeoutMs: number;
  };
}): ResourceAccessPlan {
  if (!UUID_PATTERN.test(input.resourceId)) {
    throw new Error("Invalid resource ID.");
  }
  if (!SCHEMA_PATTERN.test(input.schemaName)) {
    throw new Error("Invalid resource schema.");
  }

  const database = quoteIdentifier(input.databaseName);
  const schema = quoteIdentifier(input.schemaName);
  const owner = quoteIdentifier(input.schemaOwner);
  const roleName = `dsq_app_${input.resourceId.replace(/-/g, "").toLowerCase()}`;
  const role = quoteIdentifier(roleName);
  const password = randomBytes(32).toString("base64url");
  const limits = input.limits ?? {
    connectionLimit: 5,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 5_000,
    idleInTransactionSessionTimeoutMs: 30_000,
  };
  for (const [name, value, minimum, maximum] of [
    ["connection limit", limits.connectionLimit, 1, 50],
    ["statement timeout", limits.statementTimeoutMs, 1_000, 300_000],
    ["lock timeout", limits.lockTimeoutMs, 100, 60_000],
    ["idle transaction timeout", limits.idleInTransactionSessionTimeoutMs, 1_000, 300_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Invalid resource access ${name}.`);
    }
  }

  return {
    roleName,
    password,
    createRole: `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
    grantStatements: [
      `ALTER ROLE ${role} SET search_path TO ${schema}, pg_catalog;`,
      `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role};`,
    ],
    configureStatements: [
      `ALTER ROLE ${role} CONNECTION LIMIT ${limits.connectionLimit};`,
      `ALTER ROLE ${role} SET statement_timeout = '${limits.statementTimeoutMs}ms';`,
      `ALTER ROLE ${role} SET lock_timeout = '${limits.lockTimeoutMs}ms';`,
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${limits.idleInTransactionSessionTimeoutMs}ms';`,
      `ALTER ROLE ${role} SET application_name = 'dsquare-resource-${input.resourceId.replace(/-/g, "").toLowerCase()}';`,
      `ALTER ROLE ${role} SET timezone = 'UTC';`,
    ],
    disableRole: `ALTER ROLE ${role} NOLOGIN;`,
  };
}
