const PUBLIC_CONNECTION_FIELDS = [
  "id",
  "database_project_id",
  "database_resource_id",
  "resource_name",
  "status",
  "connected_at",
  "revoked_at",
] as const;

export function toPublicDatabaseConnection(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of PUBLIC_CONNECTION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      result[field] = row[field];
    }
  }
  return result;
}
