const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("Invalid SQL identifier.");
  return `"${value}"`;
}

export type FilteredMutation = { text: string; values: unknown[] };

function validateColumns(
  entries: Array<[string, unknown]>,
  allowedColumns: ReadonlySet<string>,
  min: number,
  max: number,
): void {
  if (entries.length < min || entries.length > max ||
      entries.some(([name]) => !IDENTIFIER.test(name) || !allowedColumns.has(name))) {
    throw new Error("Mutation contains missing or invalid columns.");
  }
}

function buildWhere(
  where: Record<string, unknown>,
  allowedColumns: ReadonlySet<string>,
  startIndex: number,
): { sql: string; values: unknown[] } {
  const entries = Object.entries(where);
  validateColumns(entries, allowedColumns, 1, 20);
  return {
    sql: entries.map(([name], index) => `${quoteIdentifier(name)} = $${startIndex + index}`).join(" AND "),
    values: entries.map(([, value]) => value),
  };
}

/** Builds a parameterized UPDATE that always requires at least one equality filter. */
export function buildDeveloperUpdateQuery(input: {
  schemaName: string;
  tableName: string;
  allowedColumns: ReadonlySet<string>;
  values: Record<string, unknown>;
  where: Record<string, unknown>;
}): FilteredMutation {
  const table = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)}`;
  const updates = Object.entries(input.values);
  validateColumns(updates, input.allowedColumns, 1, 50);
  const filters = buildWhere(input.where, input.allowedColumns, updates.length + 1);
  const assignments = updates.map(([name], index) => `${quoteIdentifier(name)} = $${index + 1}`);
  return {
    text: `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${filters.sql} RETURNING *`,
    values: [...updates.map(([, value]) => value), ...filters.values],
  };
}

/** Builds a parameterized DELETE that always requires at least one equality filter. */
export function buildDeveloperDeleteQuery(input: {
  schemaName: string;
  tableName: string;
  allowedColumns: ReadonlySet<string>;
  where: Record<string, unknown>;
}): FilteredMutation {
  const table = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)}`;
  const filters = buildWhere(input.where, input.allowedColumns, 1);
  return {
    text: `DELETE FROM ${table} WHERE ${filters.sql} RETURNING *`,
    values: filters.values,
  };
}
