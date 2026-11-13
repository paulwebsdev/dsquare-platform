import type { PoolClient } from "pg";
import { buildDeveloperDeleteQuery, buildDeveloperUpdateQuery } from "./developer-query.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
type RecordValue = Record<string, unknown>;
type TransactionOperation =
  | { type: "insert"; table: string; values: RecordValue }
  | { type: "update"; table: string; values: RecordValue; where: RecordValue }
  | { type: "delete"; table: string; where: RecordValue };

export class DeveloperTransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeveloperTransactionValidationError";
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateEntries(value: unknown, label: string, min = 1): RecordValue {
  if (!isRecord(value)) throw new DeveloperTransactionValidationError(`${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length < min || entries.length > 50 ||
      entries.some(([key, item]) => !IDENTIFIER.test(key) || item === undefined ||
        (typeof item === "number" && !Number.isFinite(item)))) {
    throw new DeveloperTransactionValidationError(`${label} must contain 1–50 valid column values.`);
  }
  return value;
}

function parseOperations(input: unknown): TransactionOperation[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new DeveloperTransactionValidationError("A transaction must contain between 1 and 20 operations.");
  }
  return input.map((raw) => {
    if (!isRecord(raw) || typeof raw.table !== "string" || !IDENTIFIER.test(raw.table)) {
      throw new DeveloperTransactionValidationError("Every transaction operation needs a valid table name.");
    }
    if (raw.type === "insert") {
      return { type: "insert", table: raw.table, values: validateEntries(raw.values, "Insert values") };
    }
    if (raw.type === "update") {
      return { type: "update", table: raw.table, values: validateEntries(raw.values, "Update values"), where: validateEntries(raw.where, "Update filter") };
    }
    if (raw.type === "delete") {
      return { type: "delete", table: raw.table, where: validateEntries(raw.where, "Delete filter") };
    }
    throw new DeveloperTransactionValidationError("Transaction operation type must be insert, update or delete.");
  });
}

/**
 * Executes a bounded batch of parameterized writes against one API-key-scoped
 * schema. The caller owns BEGIN/COMMIT/ROLLBACK so all operations are atomic.
 */
export async function executeDeveloperTransaction(
  client: Pick<PoolClient, "query">,
  schemaName: string,
  input: unknown,
): Promise<Array<{ type: string; table: string; affectedRows: number; rows: RecordValue[] }>> {
  if (!/^db_[a-f0-9]{32}$/.test(schemaName)) {
    throw new DeveloperTransactionValidationError("Invalid database resource scope.");
  }
  const operations = parseOperations(input);
  const results = [];

  for (const operation of operations) {
    const metadata = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, operation.table],
    );
    if (metadata.rowCount === 0) {
      throw new DeveloperTransactionValidationError(`Table "${operation.table}" was not found in this database resource.`);
    }
    const allowed = new Set(metadata.rows.map((row) => String(row.column_name)));
    const table = `"${schemaName}"."${operation.table}"`;
    let queryText: string;
    let values: unknown[];

    if (operation.type === "insert") {
      const entries = Object.entries(operation.values);
      if (entries.some(([column]) => !allowed.has(column))) {
        throw new DeveloperTransactionValidationError("An insert references a column that does not exist.");
      }
      queryText = `INSERT INTO ${table} (${entries.map(([column]) => `"${column}"`).join(", ")}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`;
      values = entries.map(([, value]) => value);
    } else if (operation.type === "update") {
      const query = buildDeveloperUpdateQuery({
        schemaName, tableName: operation.table, allowedColumns: allowed,
        values: operation.values, where: operation.where,
      });
      queryText = query.text;
      values = query.values;
    } else {
      const query = buildDeveloperDeleteQuery({
        schemaName, tableName: operation.table, allowedColumns: allowed, where: operation.where,
      });
      queryText = query.text;
      values = query.values;
    }

    const result = await client.query(queryText, values);
    results.push({
      type: operation.type,
      table: operation.table,
      affectedRows: result.rowCount ?? result.rows.length,
      rows: result.rows,
    });
  }

  return results;
}
