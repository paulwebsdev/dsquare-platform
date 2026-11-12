import { pool } from "../config/database.js";
import type { EncryptedDatabaseRuntimeConnection } from "./database-runtime-environment.js";

type Queryable = {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

/**
 * Loads only the active database connection explicitly assigned to this
 * website. The encrypted password stays server-side and is never returned by
 * an HTTP route. Returns null when the website has no assignment.
 */
export async function getAssignedDatabaseRuntimeConnection(input: {
  hostingUserId: string;
  resourceId: string;
  queryable?: Queryable;
}): Promise<EncryptedDatabaseRuntimeConnection | null> {
  const queryable = input.queryable ?? pool;
  const result = await queryable.query(
    `SELECT c.database_user_id AS user_id,
            c.database_project_id AS project_id,
            c.database_resource_id AS resource_id,
            c.resource_name,
            c.database_schema_name AS schema_name,
            c.database_host,
            c.database_port,
            c.database_name,
            c.database_role_name AS database_role,
            c.database_password_ciphertext,
            c.database_password_iv,
            c.database_password_auth_tag
     FROM hosting_resource_database_connections assignment
     INNER JOIN database_connections c
       ON c.id = assignment.database_connection_id
     WHERE assignment.hosting_resource_id = $1
       AND assignment.hosting_user_id = $2
       AND c.hosting_user_id = $2
       AND c.status = 'active'
     LIMIT 1`,
    [input.resourceId, input.hostingUserId],
  );

  if (result.rowCount !== 1) return null;
  const connection = result.rows[0];
  if (
    !connection.database_host ||
    !connection.database_port ||
    !connection.database_name ||
    !connection.database_role ||
    !connection.database_password_ciphertext ||
    !connection.database_password_iv ||
    !connection.database_password_auth_tag
  ) {
    throw new Error("The assigned D Database connection is missing required runtime credentials.");
  }

  return connection;
}
