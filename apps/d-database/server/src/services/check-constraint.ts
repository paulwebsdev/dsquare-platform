const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const OPERATORS = new Set(["=", "<>", ">", ">=", "<", "<="]);

export class CheckConstraintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckConstraintValidationError";
  }
}

/** Builds a deliberately small CHECK expression; arbitrary SQL is never accepted. */
export function buildCheckConstraintSql(input: {
  schemaName: string;
  tableName: string;
  constraintName: string;
  column: string;
  operator: string;
  value: unknown;
}): string {
  for (const identifier of [input.schemaName, input.tableName, input.constraintName, input.column]) {
    if (!IDENTIFIER.test(identifier) ||
        (identifier === input.schemaName && !/^db_[a-f0-9]{32}$/.test(identifier))) {
      throw new CheckConstraintValidationError("Invalid table, schema, constraint or column identifier.");
    }
  }
  if (!OPERATORS.has(input.operator)) {
    throw new CheckConstraintValidationError("CHECK constraints support =, <>, >, >=, < and <= operators.");
  }

  let literal: string;
  if (typeof input.value === "string" && input.value.length <= 500) {
    literal = `'${input.value.replace(/'/g, "''")}'`;
  } else if (typeof input.value === "number" && Number.isFinite(input.value)) {
    literal = String(input.value);
  } else if (typeof input.value === "boolean") {
    literal = input.value ? "TRUE" : "FALSE";
  } else {
    throw new CheckConstraintValidationError("CHECK values must be a string (up to 500 characters), finite number or boolean.");
  }

  return `ALTER TABLE "${input.schemaName}"."${input.tableName}" ADD CONSTRAINT "${input.constraintName}" CHECK ("${input.column}" ${input.operator} ${literal})`;
}
