export type ResourceAccessLimits = {
  connectionLimit: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
};

type Environment = Record<string, string | undefined>;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/**
 * Server-side ceilings applied to every website-specific PostgreSQL role.
 * These are PostgreSQL-enforced settings; app-provided pool settings cannot
 * raise the role's connection or statement limits.
 */
export function getResourceAccessLimits(env: Environment): ResourceAccessLimits {
  return {
    connectionLimit: boundedInteger(env.D_DATABASE_RESOURCE_CONNECTION_LIMIT, 5, "D_DATABASE_RESOURCE_CONNECTION_LIMIT", 1, 50),
    statementTimeoutMs: boundedInteger(env.D_DATABASE_RESOURCE_STATEMENT_TIMEOUT_MS, 30_000, "D_DATABASE_RESOURCE_STATEMENT_TIMEOUT_MS", 1_000, 300_000),
    lockTimeoutMs: boundedInteger(env.D_DATABASE_RESOURCE_LOCK_TIMEOUT_MS, 5_000, "D_DATABASE_RESOURCE_LOCK_TIMEOUT_MS", 100, 60_000),
    idleInTransactionSessionTimeoutMs: boundedInteger(env.D_DATABASE_RESOURCE_IDLE_TRANSACTION_TIMEOUT_MS, 30_000, "D_DATABASE_RESOURCE_IDLE_TRANSACTION_TIMEOUT_MS", 1_000, 300_000),
  };
}
