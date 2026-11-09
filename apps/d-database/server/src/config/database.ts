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

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});
