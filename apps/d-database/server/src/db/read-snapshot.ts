import type { Pool, PoolClient } from "pg";

/**
 * Runs related read queries against one PostgreSQL MVCC snapshot.
 * This keeps paginated rows and their total count consistent while writes
 * may be happening concurrently.
 */
export async function withReadSnapshot<T>(
  databasePool: Pick<Pool, "connect">,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await databasePool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
