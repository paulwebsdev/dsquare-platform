import "dotenv/config";
import { Pool } from "pg";
import { getDatabasePoolOptions } from "./pool-options.js";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  const requiredVariables = ["DB_NAME", "DB_USER", "DB_PASSWORD_BASE64"];

  for (const variable of requiredVariables) {
    if (!process.env[variable]) {
      throw new Error(`Missing required environment variable: ${variable}`);
    }
  }
}

const password = process.env.DB_PASSWORD_BASE64
  ? Buffer.from(process.env.DB_PASSWORD_BASE64, "base64").toString("utf8")
  : undefined;

export const pool = new Pool({
  ...(databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.DB_HOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password,
      }),
  ...(process.env.DB_SSL === "true"
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
  ...getDatabasePoolOptions(process.env),
});

const migrationDatabaseUrl = process.env.DB_MIGRATION_URL?.trim();
const migrationUser = process.env.DB_MIGRATION_USER?.trim();
const migrationPasswordBase64 = process.env.DB_MIGRATION_PASSWORD_BASE64;

if (
  !migrationDatabaseUrl &&
  Boolean(migrationUser) !== Boolean(migrationPasswordBase64)
) {
  throw new Error(
    "DB_MIGRATION_USER and DB_MIGRATION_PASSWORD_BASE64 must be configured together."
  );
}

const migrationPassword = migrationPasswordBase64
  ? Buffer.from(migrationPasswordBase64, "base64").toString("utf8")
  : undefined;

// Schema changes use a separate owner-capable connection when configured.
// The regular application pool always retains its restricted application role.
export const migrationPool =
  migrationDatabaseUrl || migrationUser
    ? new Pool({
        ...(migrationDatabaseUrl
          ? { connectionString: migrationDatabaseUrl }
          : {
              host: process.env.DB_MIGRATION_HOST || process.env.DB_HOST || "127.0.0.1",
              port: Number(process.env.DB_MIGRATION_PORT || process.env.DB_PORT || 5432),
              database: process.env.DB_MIGRATION_NAME || process.env.DB_NAME,
              user: migrationUser,
              password: migrationPassword,
            }),
        ...((process.env.DB_MIGRATION_SSL ?? process.env.DB_SSL) === "true"
          ? { ssl: { rejectUnauthorized: true } }
          : {}),
        ...getDatabasePoolOptions({
          ...process.env,
          DB_POOL_MAX: process.env.DB_MIGRATION_POOL_MAX || "2",
          DB_APPLICATION_NAME: "dsquare-d-hosting-migrations",
        }),
      })
    : pool;

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

if (migrationPool !== pool) {
  migrationPool.on("error", (error) => {
    console.error("Unexpected PostgreSQL migration pool error:", error.message);
  });
}
