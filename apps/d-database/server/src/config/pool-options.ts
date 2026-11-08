import type { PoolConfig } from "pg";

type Environment = Record<string, string | undefined>;

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

/** Validated, environment-configurable PostgreSQL pool settings. */
export function getDatabasePoolOptions(env: Environment): Pick<
  PoolConfig,
  "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" |
  "keepAlive" | "keepAliveInitialDelayMillis" | "maxLifetimeSeconds" |
  "application_name"
> {
  return {
    max: positiveInteger(env.DB_POOL_MAX, 10, "DB_POOL_MAX", 50),
    idleTimeoutMillis: positiveInteger(env.DB_POOL_IDLE_TIMEOUT_MS, 30_000, "DB_POOL_IDLE_TIMEOUT_MS", 300_000),
    connectionTimeoutMillis: positiveInteger(env.DB_POOL_CONNECTION_TIMEOUT_MS, 5_000, "DB_POOL_CONNECTION_TIMEOUT_MS", 60_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: positiveInteger(env.DB_POOL_MAX_LIFETIME_SECONDS, 1_800, "DB_POOL_MAX_LIFETIME_SECONDS", 86_400),
    application_name: env.DB_APPLICATION_NAME?.trim() || "dsquare-d-database",
  };
}
