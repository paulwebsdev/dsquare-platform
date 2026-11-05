export type QueryOperator =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isNull"
  | "isNotNull";

type QueryFilter = {
  column: string;
  operator: QueryOperator;
  value?: string | number | boolean;
};

type QueryBuilderInput = {
  filters?: QueryFilter[];
  logic?: "AND" | "OR";
  sort?: {
    column: string;
    direction: "asc" | "desc";
  };
  limit?: number;
  offset?: number;
};

type SafeQueryResult = {
  rowsSql: string;
  countSql: string;
  values: Array<string | number | boolean>;
  limit: number;
  offset: number;
};

export class QueryBuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryBuilderValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isScalar(
  value: unknown
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isValidIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(value);
}

const OPERATORS = new Set<QueryOperator>([
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isNull",
  "isNotNull",
]);

export function buildSafeSelectQueries(args: {
  schemaName: string;
  tableName: string;
  availableColumns: string[];
  input: unknown;
}): SafeQueryResult {
  const { schemaName, tableName, availableColumns, input } = args;

  if (
    !/^db_[a-f0-9]{32}$/.test(schemaName) ||
    !isValidIdentifier(tableName)
  ) {
    throw new QueryBuilderValidationError(
      "Invalid database schema or table name."
    );
  }

  if (!isRecord(input)) {
    throw new QueryBuilderValidationError(
      "A valid query configuration is required."
    );
  }

  const allowedColumns = new Set(availableColumns);

  const filtersInput = input.filters ?? [];

  if (!Array.isArray(filtersInput) || filtersInput.length > 10) {
    throw new QueryBuilderValidationError(
      "You can use between 0 and 10 filter conditions."
    );
  }

  const logic = input.logic ?? "AND";

  if (logic !== "AND" && logic !== "OR") {
    throw new QueryBuilderValidationError(
      "Filter logic must be AND or OR."
    );
  }

  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  ) {
    throw new QueryBuilderValidationError(
      "Limit must be 1–100 and offset must be between 0 and 1000000."
    );
  }

  const values: Array<string | number | boolean> = [];
  const conditions: string[] = [];

  for (const rawFilter of filtersInput) {
    if (!isRecord(rawFilter)) {
      throw new QueryBuilderValidationError(
        "Invalid filter condition."
      );
    }

    const column = rawFilter.column;
    const operator = rawFilter.operator;

    if (
      typeof column !== "string" ||
      !allowedColumns.has(column)
    ) {
      throw new QueryBuilderValidationError(
        "A filter uses an unknown table column."
      );
    }

    if (
      typeof operator !== "string" ||
      !OPERATORS.has(operator as QueryOperator)
    ) {
      throw new QueryBuilderValidationError(
        "Unsupported filter operator."
      );
    }

    const quotedColumn = quoteIdentifier(column);
    const selectedOperator = operator as QueryOperator;

    if (
      selectedOperator === "isNull" ||
      selectedOperator === "isNotNull"
    ) {
      conditions.push(
        `${quotedColumn} IS ${
          selectedOperator === "isNull" ? "" : "NOT "
        }NULL`
      );
      continue;
    }

    const value = rawFilter.value;

    if (!isScalar(value)) {
      throw new QueryBuilderValidationError(
        "Every filter needs a text, number, or boolean value."
      );
    }

    if (
      ["contains", "startsWith", "endsWith"].includes(
        selectedOperator
      ) &&
      typeof value !== "string"
    ) {
      throw new QueryBuilderValidationError(
        "Text search operators require a text value."
      );
    }

    values.push(value);
    const parameter = `$${values.length}`;

    switch (selectedOperator) {
      case "eq":
        conditions.push(`${quotedColumn} = ${parameter}`);
        break;
      case "neq":
        conditions.push(`${quotedColumn} <> ${parameter}`);
        break;
      case "contains":
        conditions.push(
          `POSITION(LOWER(${parameter}) IN LOWER(${quotedColumn})) > 0`
        );
        break;
      case "startsWith":
        conditions.push(
          `LEFT(LOWER(${quotedColumn}), LENGTH(${parameter})) = LOWER(${parameter})`
        );
        break;
      case "endsWith":
        conditions.push(
          `RIGHT(LOWER(${quotedColumn}), LENGTH(${parameter})) = LOWER(${parameter})`
        );
        break;
      case "gt":
        conditions.push(`${quotedColumn} > ${parameter}`);
        break;
      case "gte":
        conditions.push(`${quotedColumn} >= ${parameter}`);
        break;
      case "lt":
        conditions.push(`${quotedColumn} < ${parameter}`);
        break;
      case "lte":
        conditions.push(`${quotedColumn} <= ${parameter}`);
        break;
    }
  }

  let whereClause = "";

  if (conditions.length > 0) {
    whereClause = ` WHERE ${conditions
      .map((condition) => `(${condition})`)
      .join(` ${logic} `)}`;
  }

  let orderClause = "";

  if (input.sort !== undefined) {
    if (!isRecord(input.sort)) {
      throw new QueryBuilderValidationError(
        "Invalid sort configuration."
      );
    }

    const sortColumn = input.sort.column;
    const direction = input.sort.direction;

    if (
      typeof sortColumn !== "string" ||
      !allowedColumns.has(sortColumn)
    ) {
      throw new QueryBuilderValidationError(
        "The selected sort column does not exist."
      );
    }

    if (direction !== "asc" && direction !== "desc") {
      throw new QueryBuilderValidationError(
        "Sort direction must be asc or desc."
      );
    }

    orderClause = ` ORDER BY ${quoteIdentifier(sortColumn)} ${
      direction === "asc" ? "ASC" : "DESC"
    }`;
  }

  const qualifiedTable =
    `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;

  const countSql =
    `SELECT COUNT(*)::text AS total FROM ${qualifiedTable}${whereClause}`;

  const rowsSql =
    `SELECT * FROM ${qualifiedTable}${whereClause}${orderClause} ` +
    `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;

  return {
    rowsSql,
    countSql,
    values,
    limit,
    offset,
  };
}
