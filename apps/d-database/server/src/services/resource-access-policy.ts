import { randomBytes } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA_PATTERN = /^db_[0-9a-f]{32}$/;
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export type ResourceAccessPlan = {
  roleName: string;
  password: string;
  createRole: string;
  grantStatements: string[];
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
 * The caller must execute this only through a separately configured,
 * owner-capable provisioning connection. Never use the normal app pool.
 */
export function createResourceAccessPlan(input: {
  resourceId: string;
  schemaName: string;
  databaseName: string;
  schemaOwner: string;
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

  return {
    roleName,
    password,
    createRole: `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
    grantStatements: [
      `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role};`,
    ],
    disableRole: `ALTER ROLE ${role} NOLOGIN;`,
  };
}
