export type DeveloperApiRateLimitConfig = {
  maxRequests: number;
  windowMs: number;
};

export type DeveloperApiRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
};

type RateLimitRow = {
  request_count: number | string;
  retry_after_seconds: number | string;
};

export type DeveloperApiRateLimitQueryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: RateLimitRow[] }>;
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function getDeveloperApiRateLimitConfig(
  env: NodeJS.ProcessEnv,
): DeveloperApiRateLimitConfig {
  return {
    maxRequests: boundedInteger(env.D_DATABASE_API_RATE_LIMIT_REQUESTS, 300, 1, 10000),
    windowMs: boundedInteger(env.D_DATABASE_API_RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
  };
}

/**
 * Atomically consumes one request from a per-key fixed window stored in PostgreSQL.
 * This remains consistent across API instances and process restarts.
 */
export async function consumeDeveloperApiRateLimit(
  queryable: DeveloperApiRateLimitQueryable,
  keyId: string,
  config: DeveloperApiRateLimitConfig,
): Promise<DeveloperApiRateLimitResult> {
  const result = await queryable.query(
    `INSERT INTO developer_api_key_rate_limits
       (key_id, window_started_at, request_count, updated_at)
     VALUES ($1, NOW(), 1, NOW())
     ON CONFLICT (key_id) DO UPDATE SET
       window_started_at = CASE
         WHEN developer_api_key_rate_limits.window_started_at +
              ($2::bigint * INTERVAL '1 millisecond') <= NOW()
         THEN NOW()
         ELSE developer_api_key_rate_limits.window_started_at
       END,
       request_count = CASE
         WHEN developer_api_key_rate_limits.window_started_at +
              ($2::bigint * INTERVAL '1 millisecond') <= NOW()
         THEN 1
         ELSE developer_api_key_rate_limits.request_count + 1
       END,
       updated_at = NOW()
     RETURNING request_count,
       GREATEST(
         1,
         CEIL(EXTRACT(EPOCH FROM (
           window_started_at + ($2::bigint * INTERVAL '1 millisecond') - NOW()
         )))
       )::integer AS retry_after_seconds`,
    [keyId, config.windowMs],
  );

  const row = result.rows[0];
  if (!row) throw new Error("Developer API rate-limit state was not returned.");
  const requestCount = Number(row.request_count);
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(row.retry_after_seconds)));
  if (!Number.isSafeInteger(requestCount) || requestCount < 1 || !Number.isFinite(retryAfterSeconds)) {
    throw new Error("Developer API rate-limit state is invalid.");
  }

  return {
    allowed: requestCount <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - requestCount),
    retryAfterSeconds,
    limit: config.maxRequests,
  };
}
