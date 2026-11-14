export type DatabaseConnectionRevokeClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
};

/**
 * Removes all website assignments and marks the owner's connection revoked
 * atomically. Call only after D Database has confirmed remote credential
 * revocation; a failed local transaction must never be reported as success.
 * This helper owns the PoolClient lifecycle so every exit path releases it.
 */
export async function revokeDatabaseConnectionAssignments(input: {
  client: DatabaseConnectionRevokeClient;
  connectionId: string;
  hostingUserId: string;
}): Promise<{ id: string; status: string; revoked_at: string } | null> {
  const { client, connectionId, hostingUserId } = input;
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM hosting_resource_database_connections
       WHERE database_connection_id = $1 AND hosting_user_id = $2`,
      [connectionId, hostingUserId],
    );
    const result = await client.query(
      `UPDATE database_connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE id = $1 AND hosting_user_id = $2 AND status = 'active'
       RETURNING id, status, revoked_at`,
      [connectionId, hostingUserId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("COMMIT");
    return result.rows[0] as { id: string; status: string; revoked_at: string };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
