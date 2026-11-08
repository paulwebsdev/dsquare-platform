import { Router, type Response } from "express";
import { pool } from "../config/database.js";
import { withReadSnapshot } from "../db/read-snapshot.js";
import {
  buildSafeSelectQueries,
  QueryBuilderValidationError,
} from "../services/query-builder.service.js";

const router = Router({ mergeParams: true });

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

const SQL_TYPES = {
  text: "TEXT",
  integer: "INTEGER",
  bigint: "BIGINT",
  numeric: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamptz: "TIMESTAMPTZ",
  uuid: "UUID",
  jsonb: "JSONB",
} as const;

type ColumnInput = {
  name: string;
  type: keyof typeof SQL_TYPES;
  nullable?: boolean;
  primaryKey?: boolean;
};

function getParams(req: { params: object }) {
  return req.params as Record<string, string>;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function sendError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;

  if (code === "42P07") {
    return res.status(409).json({
      success: false,
      message: "A table with this name already exists in this database resource.",
    });
  }

  console.error(
    "D Database table error:",
    error instanceof Error ? error.message : error
  );

  return res.status(500).json({
    success: false,
    message: "Could not complete the table operation.",
  });
}

async function findResource(projectId: string, resourceId: string) {
  const result = await pool.query(
    `SELECT id, project_id, schema_name, status
     FROM database_resources
     WHERE id = $1 AND project_id = $2`,
    [resourceId, projectId]
  );

  return result.rows[0] as
    | { id: string; project_id: string; schema_name: string; status: string }
    | undefined;
}

function validResourceSchema(schemaName: string) {
  return /^db_[a-f0-9]{32}$/.test(schemaName);
}

// List tables belonging to one database resource.
router.get("/:resourceId/tables", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";

  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid project or resource ID.",
    });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({ success: false, message: "Database resource not found." });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(500).json({ success: false, message: "Invalid database schema configuration." });
    }

    const result = await pool.query(
      `SELECT t.table_name,
          (SELECT COUNT(*)::integer
           FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema
             AND c.table_name = t.table_name) AS column_count
       FROM information_schema.tables t
       WHERE t.table_schema = $1
         AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`,
      [resource.schema_name]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      tables: result.rows,
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Create a table using an allowlisted set of PostgreSQL types.
router.post("/:resourceId/tables", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";

  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid project or resource ID.",
    });
  }

  const body = req.body as Record<string, unknown>;
  const tableName = body?.name;
  const inputColumns = body?.columns;

  if (!validIdentifier(tableName)) {
    return res.status(400).json({
      success: false,
      message: "Table names must start with a lowercase letter and contain only lowercase letters, numbers and underscores (maximum 63 characters).",
    });
  }

  if (
    !Array.isArray(inputColumns) ||
    inputColumns.length < 1 ||
    inputColumns.length > 30
  ) {
    return res.status(400).json({
      success: false,
      message: "A table must have between 1 and 30 columns.",
    });
  }

  const columns: ColumnInput[] = [];
  const names = new Set<string>();
  let primaryKeyCount = 0;

  for (const rawColumn of inputColumns) {
    if (!rawColumn || typeof rawColumn !== "object" || Array.isArray(rawColumn)) {
      return res.status(400).json({ success: false, message: "Invalid column definition." });
    }

    const column = rawColumn as Record<string, unknown>;

    if (!validIdentifier(column.name)) {
      return res.status(400).json({
        success: false,
        message: "Column names must start with a lowercase letter and use only lowercase letters, numbers and underscores.",
      });
    }

    if (names.has(column.name)) {
      return res.status(400).json({
        success: false,
        message: `Duplicate column name: ${column.name}`,
      });
    }

    names.add(column.name);

    if (
      typeof column.type !== "string" ||
      !Object.prototype.hasOwnProperty.call(SQL_TYPES, column.type)
    ) {
      return res.status(400).json({
        success: false,
        message: `Unsupported data type for column ${column.name}.`,
      });
    }

    if (
      column.nullable !== undefined &&
      typeof column.nullable !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid nullable setting for column ${column.name}.`,
      });
    }

    if (
      column.primaryKey !== undefined &&
      typeof column.primaryKey !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid primary-key setting for column ${column.name}.`,
      });
    }

    if (column.primaryKey === true) primaryKeyCount++;

    columns.push({
      name: column.name,
      type: column.type as keyof typeof SQL_TYPES,
      nullable: column.nullable !== false,
      primaryKey: column.primaryKey === true,
    });
  }

  if (primaryKeyCount > 1) {
    return res.status(400).json({
      success: false,
      message: "Only one primary-key column is supported in this version.",
    });
  }

  const columnDefinitions = columns.map((column) => {
    const parts = [
      quoteIdentifier(column.name),
      SQL_TYPES[column.type],
    ];

    if (column.primaryKey || !column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.primaryKey) {
      parts.push("PRIMARY KEY");
    }

    return parts.join(" ");
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const resourceResult = await client.query(
      `SELECT schema_name, status
       FROM database_resources
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [resourceId, projectId]
    );

    if (resourceResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Database resource not found." });
    }

    const resource = resourceResult.rows[0] as {
      schema_name: string;
      status: string;
    };

    if (!validResourceSchema(resource.schema_name)) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: "Invalid database schema configuration." });
    }

    if (resource.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Restore this database resource before creating tables.",
      });
    }

    await client.query(
      `CREATE TABLE ${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}
       (${columnDefinitions.join(", ")})`
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Table created successfully.",
      table: {
        name: tableName,
        schema: resource.schema_name,
        columns,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return sendError(error, res);
  } finally {
    client.release();
  }
});

// Inspect the columns of a table.
router.get("/:resourceId/tables/:tableName", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({ success: false, message: "Invalid project, resource or table identifier." });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({ success: false, message: "Database resource not found." });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(500).json({ success: false, message: "Invalid database schema configuration." });
    }

    const result = await pool.query(
      `SELECT
         c.column_name,
         c.data_type,
         c.is_nullable,
         c.column_default,
         c.ordinal_position,
         EXISTS (
           SELECT 1
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage k
             ON k.constraint_catalog = tc.constraint_catalog
            AND k.constraint_schema = tc.constraint_schema
            AND k.constraint_name = tc.constraint_name
            AND k.table_schema = tc.table_schema
            AND k.table_name = tc.table_name
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = c.table_schema
             AND tc.table_name = c.table_name
             AND k.column_name = c.column_name
         ) AS is_primary_key
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [resource.schema_name, tableName]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Table not found." });
    }

    return res.json({
      success: true,
      table: tableName,
      schema: resource.schema_name,
      columns: result.rows,
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Read a page of rows without allowing arbitrary SQL.
router.get("/:resourceId/tables/:tableName/rows", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({ success: false, message: "Invalid project, resource or table identifier." });
  }

  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  ) {
    return res.status(400).json({
      success: false,
      message: "Limit must be 1â€“100 and offset must be a non-negative integer.",
    });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({ success: false, message: "Database resource not found." });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(500).json({ success: false, message: "Invalid database schema configuration." });
    }

    const exists = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name = $2
         AND table_type = 'BASE TABLE'`,
      [resource.schema_name, tableName]
    );

    if (exists.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Table not found." });
    }

    const qualifiedTable =
      `${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}`;

    const page = await withReadSnapshot(pool, async (client) => {
      const rows = await client.query(
        `SELECT * FROM ${qualifiedTable} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const total = await client.query(
        `SELECT COUNT(*)::text AS total FROM ${qualifiedTable}`
      );
      return { rows: rows.rows, total: total.rows[0].total };
    });

    return res.json({
      success: true,
      table: tableName,
      limit,
      offset,
      total: page.total,
      rows: page.rows,
    });
  } catch (error) {
    return sendError(error, res);
  }
});



// Execute a validated visual query against a database table.
router.post("/:resourceId/tables/:tableName/query", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource or table identifier.",
    });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Database resource not found.",
      });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(500).json({
        success: false,
        message: "Invalid database schema configuration.",
      });
    }

    if (resource.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "This database resource is not active.",
      });
    }

    const columnsResult = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
       ORDER BY ordinal_position`,
      [resource.schema_name, tableName]
    );

    if (columnsResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Table not found or contains no columns.",
      });
    }

    const availableColumns = columnsResult.rows.map(
      (column: { column_name: string }) => column.column_name
    );

    const query = buildSafeSelectQueries({
      schemaName: resource.schema_name,
      tableName,
      availableColumns,
      input: req.body,
    });

    const page = await withReadSnapshot(pool, async (client) => {
      const rows = await client.query(query.rowsSql, [
        ...query.values,
        query.limit,
        query.offset,
      ]);
      const total = await client.query(query.countSql, query.values);
      return { rows: rows.rows, total: total.rows[0].total };
    });

    return res.json({
      success: true,
      table: tableName,
      limit: query.limit,
      offset: query.offset,
      total: page.total,
      rows: page.rows,
    });
  } catch (error) {
    if (error instanceof QueryBuilderValidationError) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return sendError(error, res);
  }
});
// ======================================================
// D DATABASE SAFE ROW OPERATIONS
// ======================================================

type MutableTableColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  is_generated: string;
  is_primary_key: boolean;
};

async function resolveMutableTable(
  projectId: string,
  resourceId: string,
  tableName: string
) {
  const resource = await findResource(projectId, resourceId);

  if (!resource || !validResourceSchema(resource.schema_name)) {
    return null;
  }

  const result = await pool.query(
    `SELECT
       c.column_name,
       c.data_type,
       c.is_nullable,
       c.column_default,
       c.is_identity,
       c.is_generated,
       EXISTS (
         SELECT 1
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k
           ON k.constraint_catalog = tc.constraint_catalog
          AND k.constraint_schema = tc.constraint_schema
          AND k.constraint_name = tc.constraint_name
          AND k.table_schema = tc.table_schema
          AND k.table_name = tc.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = c.table_schema
           AND tc.table_name = c.table_name
           AND k.column_name = c.column_name
       ) AS is_primary_key
     FROM information_schema.columns c
     WHERE c.table_schema = $1 AND c.table_name = $2
     ORDER BY c.ordinal_position`,
    [resource.schema_name, tableName]
  );

  if (result.rowCount === 0) return null;

  return {
    schemaName: resource.schema_name,
    resourceStatus: resource.status,
    columns: result.rows as MutableTableColumn[],
  };
}

function validateRowValues(
  input: unknown,
  columns: MutableTableColumn[],
  allowPrimaryKey: boolean
): { entries?: Array<{ name: string; value: unknown }>; error?: string } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return { error: "Provide record values as a JSON object." };
  }

  const entries = Object.entries(input as Record<string, unknown>);

  if (entries.length > columns.length) {
    return { error: "Too many values were provided." };
  }

  const validated: Array<{ name: string; value: unknown }> = [];

  for (const [name, value] of entries) {
    if (!validIdentifier(name)) {
      return { error: `Invalid column name: ${name}` };
    }

    const column = columns.find((item) => item.column_name === name);

    if (!column) {
      return { error: `Unknown column: ${name}` };
    }

    if (column.is_generated === "ALWAYS") {
      return { error: `Column ${name} is generated automatically.` };
    }

    if (column.is_identity === "YES" && column.is_primary_key) {
      return { error: `Identity column ${name} cannot be supplied manually.` };
    }

    if (!allowPrimaryKey && column.is_primary_key) {
      return { error: "The primary key cannot be changed." };
    }

    validated.push({ name, value });
  }

  return { entries: validated };
}

function sendRowOperationError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;

  if (code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A record with this primary key or unique value already exists.",
    });
  }

  if (
    code === "23502" ||
    code === "22P02" ||
    code === "22007" ||
    code === "22003" ||
    code === "22P03" ||
    code === "23514"
  ) {
    return res.status(400).json({
      success: false,
      message: "The supplied values do not match the table's data requirements.",
    });
  }

  return sendError(error, res);
}

// Insert a new record.
router.post("/:resourceId/tables/:tableName/rows", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource or table identifier.",
    });
  }

  try {
    const table = await resolveMutableTable(projectId, resourceId, tableName);

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Database resource or table not found.",
      });
    }

    if (table.resourceStatus !== "active") {
      return res.status(409).json({
        success: false,
        message: "Restore this database resource before modifying its records.",
      });
    }

    const body = req.body as Record<string, unknown>;
    const checked = validateRowValues(
      body?.values,
      table.columns,
      true
    );

    if (checked.error || !checked.entries) {
      return res.status(400).json({
        success: false,
        message: checked.error || "Invalid record values.",
      });
    }

    if (checked.entries.length === 0) {
      const result = await pool.query(
        `INSERT INTO ${quoteIdentifier(table.schemaName)}.${quoteIdentifier(tableName)}
         DEFAULT VALUES RETURNING *`
      );

      return res.status(201).json({
        success: true,
        message: "Record created.",
        row: result.rows[0],
      });
    }

    const names = checked.entries.map((entry) => entry.name);
    const placeholders = checked.entries.map((_, index) => `$${index + 1}`);
    const values = checked.entries.map((entry) => entry.value);

    const result = await pool.query(
      `INSERT INTO ${quoteIdentifier(table.schemaName)}.${quoteIdentifier(tableName)}
       (${names.map(quoteIdentifier).join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      values
    );

    return res.status(201).json({
      success: true,
      message: "Record created.",
      row: result.rows[0],
    });
  } catch (error) {
    return sendRowOperationError(error, res);
  }
});

// Update one record using its single-column primary key.
router.patch("/:resourceId/tables/:tableName/rows", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource or table identifier.",
    });
  }

  try {
    const table = await resolveMutableTable(projectId, resourceId, tableName);

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Database resource or table not found.",
      });
    }

    if (table.resourceStatus !== "active") {
      return res.status(409).json({
        success: false,
        message: "Restore this database resource before modifying its records.",
      });
    }

    const primaryKeys = table.columns.filter((column) => column.is_primary_key);

    if (primaryKeys.length !== 1) {
      return res.status(409).json({
        success: false,
        message: "Record editing requires exactly one primary-key column.",
      });
    }

    const body = req.body as Record<string, unknown>;

    if (
      !Object.prototype.hasOwnProperty.call(body || {}, "primaryKeyValue") ||
      body.primaryKeyValue === null
    ) {
      return res.status(400).json({
        success: false,
        message: "A primaryKeyValue is required.",
      });
    }

    const checked = validateRowValues(
      body?.values,
      table.columns,
      false
    );

    if (checked.error || !checked.entries || checked.entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: checked.error || "Provide at least one field to update.",
      });
    }

    const assignments = checked.entries.map(
      (entry, index) =>
        `${quoteIdentifier(entry.name)} = $${index + 1}`
    );

    const values = checked.entries.map((entry) => entry.value);
    values.push(body.primaryKeyValue);

    const result = await pool.query(
      `UPDATE ${quoteIdentifier(table.schemaName)}.${quoteIdentifier(tableName)}
       SET ${assignments.join(", ")}
       WHERE ${quoteIdentifier(primaryKeys[0].column_name)} = $${values.length}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Record not found.",
      });
    }

    return res.json({
      success: true,
      message: "Record updated.",
      row: result.rows[0],
    });
  } catch (error) {
    return sendRowOperationError(error, res);
  }
});

// Delete one record using its single-column primary key.
router.delete("/:resourceId/tables/:tableName/rows", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource or table identifier.",
    });
  }

  try {
    const table = await resolveMutableTable(projectId, resourceId, tableName);

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Database resource or table not found.",
      });
    }

    if (table.resourceStatus !== "active") {
      return res.status(409).json({
        success: false,
        message: "Restore this database resource before modifying its records.",
      });
    }

    const primaryKeys = table.columns.filter((column) => column.is_primary_key);

    if (primaryKeys.length !== 1) {
      return res.status(409).json({
        success: false,
        message: "Record deletion requires exactly one primary-key column.",
      });
    }

    const body = req.body as Record<string, unknown>;

    if (
      !Object.prototype.hasOwnProperty.call(body || {}, "primaryKeyValue") ||
      body.primaryKeyValue === null
    ) {
      return res.status(400).json({
        success: false,
        message: "A primaryKeyValue is required.",
      });
    }

    const result = await pool.query(
      `DELETE FROM ${quoteIdentifier(table.schemaName)}.${quoteIdentifier(tableName)}
       WHERE ${quoteIdentifier(primaryKeys[0].column_name)} = $1
       RETURNING *`,
      [body.primaryKeyValue]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Record not found.",
      });
    }

    return res.json({
      success: true,
      message: "Record deleted.",
      row: result.rows[0],
    });
  } catch (error) {
    return sendRowOperationError(error, res);
  }
});

// Add, rename, or remove a table column.
router.patch("/:resourceId/tables/:tableName", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";
  const { newTableName } = req.body ?? {};

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName) ||
    !validIdentifier(newTableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource, or table name.",
    });
  }

  if (tableName === newTableName) {
    return res.status(400).json({
      success: false,
      message: "Choose a different table name.",
    });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Database resource not found.",
      });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(400).json({
        success: false,
        message: "Invalid database schema.",
      });
    }

    if (resource.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "This database resource is not active.",
      });
    }

    const existingTable = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ($2, $3)
         AND table_type = 'BASE TABLE'`,
      [resource.schema_name, tableName, newTableName]
    );

    const names = existingTable.rows.map((row) => row.table_name);

    if (!names.includes(tableName)) {
      return res.status(404).json({
        success: false,
        message: "Table not found.",
      });
    }

    if (names.includes(newTableName)) {
      return res.status(409).json({
        success: false,
        message: "A table with the new name already exists.",
      });
    }

    await pool.query(
      `ALTER TABLE ${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}
       RENAME TO ${quoteIdentifier(newTableName)}`
    );

    return res.json({
      success: true,
      message: "Table renamed successfully.",
    });
  } catch (error) {
    return sendError(error, res);
  }
});
router.patch("/:resourceId/tables/:tableName/columns", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const tableName = params.tableName || "";
  const { action, columnName, newColumnName, type } = req.body ?? {};

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !validIdentifier(tableName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid project, resource, or table name.",
    });
  }

  if (!["add", "rename", "drop"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Action must be add, rename, or drop.",
    });
  }

  if (!validIdentifier(columnName)) {
    return res.status(400).json({
      success: false,
      message: "Invalid column name.",
    });
  }

  if (action === "add" && (
    typeof type !== "string" ||
    !Object.prototype.hasOwnProperty.call(SQL_TYPES, type)
  )) {
    return res.status(400).json({
      success: false,
      message: "Unsupported column type.",
    });
  }

  if (action === "rename" && !validIdentifier(newColumnName)) {
    return res.status(400).json({
      success: false,
      message: "Invalid new column name.",
    });
  }

  try {
    const resource = await findResource(projectId, resourceId);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Database resource not found.",
      });
    }

    if (!validResourceSchema(resource.schema_name)) {
      return res.status(400).json({
        success: false,
        message: "Invalid database schema.",
      });
    }

    if (resource.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "This database resource is not active.",
      });
    }

    const tableResult = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [resource.schema_name, tableName]
    );

    if (tableResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Table not found.",
      });
    }

    const columnsResult = await pool.query(
      `SELECT column_name,
              is_nullable,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.column_name = c.column_name
              ) AS is_primary_key
       FROM information_schema.columns c
       WHERE table_schema = $1 AND table_name = $2`,
      [resource.schema_name, tableName]
    );

    const columns = columnsResult.rows as Array<{
      column_name: string;
      is_nullable: string;
      is_primary_key: boolean;
    }>;

    const existingColumn = columns.find(
      (column) => column.column_name === columnName
    );

    if (action !== "add" && !existingColumn) {
      return res.status(404).json({
        success: false,
        message: "Column not found.",
      });
    }

    if (action === "add") {
      if (existingColumn) {
        return res.status(409).json({
          success: false,
          message: "A column with this name already exists.",
        });
      }

      await pool.query(
        `ALTER TABLE ${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}
         ADD COLUMN ${quoteIdentifier(columnName)} ${SQL_TYPES[type as keyof typeof SQL_TYPES]}`,
      );
    }

    if (action === "rename") {
      if (columnName === newColumnName) {
        return res.status(400).json({
          success: false,
          message: "Choose a different column name.",
        });
      }

      if (columns.some((column) => column.column_name === newColumnName)) {
        return res.status(409).json({
          success: false,
          message: "A column with the new name already exists.",
        });
      }

      await pool.query(
        `ALTER TABLE ${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}
         RENAME COLUMN ${quoteIdentifier(columnName)} TO ${quoteIdentifier(newColumnName)}`
      );
    }

    if (action === "drop") {
      if (existingColumn?.is_primary_key) {
        return res.status(409).json({
          success: false,
          message: "Primary-key columns cannot be removed here.",
        });
      }

      if (columns.length <= 1) {
        return res.status(409).json({
          success: false,
          message: "A table must have at least one column.",
        });
      }

      await pool.query(
        `ALTER TABLE ${quoteIdentifier(resource.schema_name)}.${quoteIdentifier(tableName)}
         DROP COLUMN ${quoteIdentifier(columnName)}`
      );
    }

    return res.json({
      success: true,
      message: "Column updated successfully.",
    });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;

