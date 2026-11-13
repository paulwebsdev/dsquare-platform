export class TableConstraintValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TableConstraintValidationError"; }
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const OPERATORS = new Set(["=", "<>", ">", ">=", "<", "<="]);

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new TableConstraintValidationError("Invalid SQL identifier.");
  return `"${value}"`;
}

function sqlLiteral(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  throw new TableConstraintValidationError("Check constraints require a string, finite number or boolean value.");
}

/** Builds a safe, named single-column CHECK constraint without accepting SQL fragments. */
export function buildCheckConstraintSql(input: {
  schemaName: string;
  tableName: string;
  constraintName: string;
  columnName: string;
  operator: string;
  value: unknown;
}): string {
  if (!/^db_[a-f0-9]{32}$/.test(input.schemaName) ||
      !IDENTIFIER.test(input.tableName) ||
      !IDENTIFIER.test(input.constraintName) ||
      !IDENTIFIER.test(input.columnName) ||
      !OPERATORS.has(input.operator)) {
    throw new TableConstraintValidationError("Invalid check constraint definition.");
  }
  return `ALTER TABLE ${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)} ADD CONSTRAINT ${quoteIdentifier(input.constraintName)} CHECK (${quoteIdentifier(input.columnName)} ${input.operator} ${sqlLiteral(input.value)})`;
}
