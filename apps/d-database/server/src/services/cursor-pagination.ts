const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export class CursorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorValidationError";
  }
}

export function encodePrimaryKeyCursor(value: unknown): string {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (normalized === null || normalized === undefined ||
      !["string", "number", "boolean"].includes(typeof normalized) ||
      (typeof normalized === "number" && !Number.isFinite(normalized))) {
    throw new CursorValidationError("The primary-key value cannot be used for cursor pagination.");
  }
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function decodePrimaryKeyCursor(cursor: string): string | number | boolean {
  if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new CursorValidationError("Invalid pagination cursor.");
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value: unknown = JSON.parse(decoded);
    if (value === null || !["string", "number", "boolean"].includes(typeof value) ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      throw new Error("invalid cursor value");
    }
    return value as string | number | boolean;
  } catch {
    throw new CursorValidationError("Invalid pagination cursor.");
  }
}

export function buildPrimaryKeyCursorQuery(input: {
  schemaName: string;
  tableName: string;
  primaryKey: string;
  limit: number;
  cursor?: string;
}): { text: string; values: Array<string | number | boolean> } {
  if (!/^db_[a-f0-9]{32}$/.test(input.schemaName) ||
      !IDENTIFIER.test(input.tableName) || !IDENTIFIER.test(input.primaryKey)) {
    throw new CursorValidationError("Invalid database table or primary-key identifier.");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new CursorValidationError("Limit must be between 1 and 100.");
  }
  const table = `"${input.schemaName}"."${input.tableName}"`;
  const primaryKey = `"${input.primaryKey}"`;
  if (input.cursor !== undefined) {
    const value = decodePrimaryKeyCursor(input.cursor);
    return {
      text: `SELECT * FROM ${table} WHERE ${primaryKey} > $1 ORDER BY ${primaryKey} ASC LIMIT $2`,
      values: [value, input.limit + 1],
    };
  }
  return {
    text: `SELECT * FROM ${table} ORDER BY ${primaryKey} ASC LIMIT $1`,
    values: [input.limit + 1],
  };
}
