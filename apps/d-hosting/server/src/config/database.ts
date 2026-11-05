import "dotenv/config";
import { Pool } from "pg";

const requiredVariables = [
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD_BASE64",
];

for (const variable of requiredVariables) {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
}

const password = Buffer.from(
  process.env.DB_PASSWORD_BASE64!,
  "base64"
).toString("utf8");

export const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});