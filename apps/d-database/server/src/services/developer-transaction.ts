import type { PoolClient, QueryResult } from "pg";
import { buildDeveloperDeleteQuery, buildDeveloperUpdateQuery } from "./developer-query.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_OPERATIONS = 20;

export type DeveloperTransactionOperation =
  | { type: "insert"; table: string; values: Record<string, unknown> }
  | { type: "update"; table: string; values: Record<string, unknown>; where: Record<string, unknown> }
  | { type: "delete"; table: string; where: Record<string, unknown> };

export class DeveloperTransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeveloperTransactionValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new DeveloperTransactionValidationError("Invalid table or column identifier.");
  return `"${value}"`;
}

function validateEntries(
  value: unknown,
  allowed: ReadonlySet<string>,
  minimum: number,
  maximum: number,
): Array<[string, unknown]> {
  if (!isRecord(value)) throw new DeveloperTransactionValidationError("Each operation requires a values or where object.");
  const entries = Object.entries(value);
  if (entries.length < minimum || entries.length > maximum ||
      entries.some(([name]) => !IDENTIFIER.test(name) || !allowed.has(name))) {
    throw new DeveloperTransactionValidationError("An operation contains missing or invalid columns.");
  }
  return entries;
}

/** Executes a bounded, resource-scoped set of row mutations on the caller's transaction client. */
export async function executeDeveloperTransaction(
  client: Pick<PoolClient, "query">,
  schemaName: string,
  input: unknown,
): Promise<Array<{ type: string; table: string; affectedCount: number; rows: unknown[] }>> {
  if (!/^db_[a-f0-9]{32}$/.test(schemaName)) {
    throw new DeveloperTransactionValidationError("Invalid database resource scope.");
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_OPERATIONS) {
    throw new DeveloperTransactionValidationError(`A transaction must contain between 1 and ${MAX_OPERATIONS} operations.`);
  }

  const results: Array<{ type: string; table: string; affectedCount: number; rows: unknown[] }> = [];
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.type !== "string" ||
        typeof raw.table !== "string" || !IDENTIFIER.test(raw.table)) {
      throw new DeveloperTransactionValidationError("Each operation needs a supported type and valid table name.");
    }
    const table = raw.table;
    const metadata = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, table],
    );
    if (!metadata.rowCount) throw new DeveloperTransactionValidationError(`Table not found: ${table}.`);
    const allowed = new Set(metadata.rows.map((row: { column_name: string }) => row.column_name));
    const qualifiedTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`;
    let result: QueryResult;

    if (raw.type === "insert") {
      const entries = validateEntries(raw.values, allowed, 1, 50);
      const columns = entries.map(([name]) => quoteIdentifier(name));
      const placeholders = entries.map((_, index) => `$${index + 1}`);
      result = await client.query(
        `INSERT INTO ${qualifiedTable} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
        entries.map(([, value]) => value),
      );
    } else if (raw.type === "update") {
      if (!isRecord(raw.values) || !isRecord(raw.where)) {
        throw new DeveloperTransactionValidationError("Update operations require values and where objects.");
      }
      const query = buildDeveloperUpdateQuery({
        schemaName, tableName: table, allowedColumns: allowed,
        values: raw.values, where: raw.where,
      });
      result = await client.query(query.text, query.values);
    } else if (raw.type === "delete") {
      if (!isRecord(raw.where)) throw new DeveloperTransactionValidationError("Delete operations require a where object.");
      const query = buildDeveloperDeleteQuery({
        schemaName, tableName: table, allowedColumns: allowed, where: raw.where,
      });
      result = await client.query(query.text, query.values);
    } else {
      throw new DeveloperTransactionValidationError("Operation type must be insert, update, or delete.");
    }

    results.push({
      type: raw.type,
      table,
      affectedCount: result.rowCount ?? 0,
      rows: result.rows,
    });
  }
  return results;
}
