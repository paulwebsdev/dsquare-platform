import { Router, type Response } from "express";
import { pool } from "../config/database.js";
import { buildCheckConstraintSql } from "../services/check-constraint.js";

const router = Router({ mergeParams: true });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

function params(req: { params: object }) {
  return req.params as Record<string, string>;
}

function sendError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;
  if (code === "42P07" || code === "42710" || code === "42P16") {
    return res.status(409).json({ success: false, message: "An index or constraint with that name already exists." });
  }
  if (code === "23503") {
    return res.status(409).json({ success: false, message: "The foreign key cannot be added because existing records violate the relationship." });
  }
  if (code === "23505") {
    return res.status(409).json({ success: false, message: "The unique constraint cannot be added because duplicate values already exist." });
  }
  if (code === "42830") {
    return res.status(400).json({ success: false, message: "The referenced column must have a primary-key or unique constraint." });
  }
  console.error("D Database structure error:", error instanceof Error ? error.message : error);
  return res.status(500).json({ success: false, message: "Could not complete the table-structure operation." });
}

type TableResolution =
  | { ok: true; schemaName: string; tableName: string }
  | { ok: false; error: string; status: number };

async function resolveTable(projectId: string, resourceId: string, tableName: string): Promise<TableResolution> {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId) || !IDENTIFIER_PATTERN.test(tableName)) {
    return { ok: false, error: "Invalid project, resource or table identifier.", status: 400 };
  }
  const resourceResult = await pool.query(
    `SELECT schema_name, status FROM database_resources WHERE id = $1 AND project_id = $2 LIMIT 1`,
    [resourceId, projectId]
  );
  if (resourceResult.rowCount === 0) return { ok: false, error: "Database resource not found.", status: 404 };
  const resource = resourceResult.rows[0] as { schema_name: string; status: string };
  if (!/^db_[a-f0-9]{32}$/.test(resource.schema_name)) {
    return { ok: false, error: "Invalid database schema configuration.", status: 500 };
  }
  const tableResult = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
    [resource.schema_name, tableName]
  );
  if (tableResult.rowCount === 0) return { ok: false, error: "Table not found.", status: 404 };
  if (resource.status !== "active") return { ok: false, error: "Restore this database resource before changing its structure.", status: 409 };
  return { ok: true, schemaName: resource.schema_name, tableName };
}

function sendResolveError(result: Extract<TableResolution, { ok: false }>, res: Response) {
  return res.status(result.status).json({ success: false, message: result.error });
}

// Inspect PostgreSQL indexes and constraints for a table.
router.get("/:resourceId/tables/:tableName/structure", async (req, res) => {
  const { projectId = "", resourceId = "", tableName = "" } = params(req);
  try {
    const table = await resolveTable(projectId, resourceId, tableName);
    if (!table.ok) return sendResolveError(table, res);

    const [indexes, constraints] = await Promise.all([
      pool.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2
         ORDER BY indexname`,
        [table.schemaName, tableName]
      ),
      pool.query(
        `SELECT con.conname AS name,
                CASE con.contype WHEN 'p' THEN 'primary_key'
                                 WHEN 'u' THEN 'unique'
                                 WHEN 'f' THEN 'foreign_key'
                                 WHEN 'c' THEN 'check'
                                 ELSE con.contype::text END AS type,
                pg_get_constraintdef(con.oid, true) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = $1 AND rel.relname = $2
         ORDER BY con.conname`,
        [table.schemaName, tableName]
      ),
    ]);

    return res.json({ success: true, indexes: indexes.rows, constraints: constraints.rows });
  } catch (error) {
    return sendError(error, res);
  }
});

// Create a regular or unique index using validated table columns.
router.post("/:resourceId/tables/:tableName/indexes", async (req, res) => {
  const { projectId = "", resourceId = "", tableName = "" } = params(req);
  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const columns = body?.columns;
  const unique = body?.unique === true;

  if (!IDENTIFIER_PATTERN.test(name)) {
    return res.status(400).json({ success: false, message: "Index name must start with a lowercase letter and contain only lowercase letters, numbers and underscores." });
  }
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 5 ||
      columns.some(column => typeof column !== "string" || !IDENTIFIER_PATTERN.test(column)) ||
      new Set(columns).size !== columns.length) {
    return res.status(400).json({ success: false, message: "Choose between 1 and 5 distinct valid columns." });
  }

  try {
    const table = await resolveTable(projectId, resourceId, tableName);
    if (!table.ok) return sendResolveError(table, res);
    const existingColumns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [table.schemaName, tableName]
    );
    const allowed = new Set(existingColumns.rows.map(row => row.column_name));
    if (columns.some(column => !allowed.has(column as string))) {
      return res.status(400).json({ success: false, message: "One or more selected columns do not exist in this table." });
    }

    await pool.query(
      `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(table.schemaName)}.${quote(tableName)} (${(columns as string[]).map(quote).join(", ")})`
    );
    return res.status(201).json({ success: true, message: unique ? "Unique index created." : "Index created." });
  } catch (error) {
    return sendError(error, res);
  }
});

// Delete only a standalone index belonging to the selected table.
router.delete("/:resourceId/tables/:tableName/indexes/:indexName", async (req, res) => {
  const { projectId = "", resourceId = "", tableName = "", indexName = "" } = params(req);
  if (!IDENTIFIER_PATTERN.test(indexName)) {
    return res.status(400).json({ success: false, message: "Invalid index name." });
  }
  try {
    const table = await resolveTable(projectId, resourceId, tableName);
    if (!table.ok) return sendResolveError(table, res);
    const result = await pool.query(
      `SELECT idx.relname AS index_name
       FROM pg_class idx
       JOIN pg_index pi ON pi.indexrelid = idx.oid
       JOIN pg_class tbl ON tbl.oid = pi.indrelid
       JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
       WHERE ns.nspname = $1 AND tbl.relname = $2 AND idx.relname = $3
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = idx.oid)`,
      [table.schemaName, tableName, indexName]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Standalone index not found. Primary-key and constraint indexes cannot be deleted here." });
    }
    await pool.query(`DROP INDEX ${quote(table.schemaName)}.${quote(indexName)}`);
    return res.json({ success: true, message: "Index deleted." });
  } catch (error) {
    return sendError(error, res);
  }
});

// Add UNIQUE or FOREIGN KEY constraints. Foreign keys stay within this resource schema.
router.post("/:resourceId/tables/:tableName/constraints", async (req, res) => {
  const { projectId = "", resourceId = "", tableName = "" } = params(req);
  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const type = body?.type;
  if (!IDENTIFIER_PATTERN.test(name)) {
    return res.status(400).json({ success: false, message: "Constraint name must be a valid lowercase identifier." });
  }

  try {
    const table = await resolveTable(projectId, resourceId, tableName);
    if (!table.ok) return sendResolveError(table, res);

    if (type === "unique") {
      const columns = body.columns;
      if (!Array.isArray(columns) || columns.length < 1 || columns.length > 5 ||
          columns.some(column => typeof column !== "string" || !IDENTIFIER_PATTERN.test(column)) ||
          new Set(columns).size !== columns.length) {
        return res.status(400).json({ success: false, message: "Choose between 1 and 5 distinct valid columns." });
      }
      const existing = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [table.schemaName, tableName]
      );
      const allowed = new Set(existing.rows.map(row => row.column_name));
      if (columns.some(column => !allowed.has(column as string))) {
        return res.status(400).json({ success: false, message: "One or more selected columns do not exist in this table." });
      }
      await pool.query(
        `ALTER TABLE ${quote(table.schemaName)}.${quote(tableName)} ADD CONSTRAINT ${quote(name)} UNIQUE (${(columns as string[]).map(quote).join(", ")})`
      );
    } else if (type === "foreign_key") {
      const column = typeof body.column === "string" ? body.column : "";
      const referencedTable = typeof body.referencedTable === "string" ? body.referencedTable : "";
      const referencedColumn = typeof body.referencedColumn === "string" ? body.referencedColumn : "";
      const onDelete = typeof body.onDelete === "string" ? body.onDelete : "NO ACTION";
      const allowedActions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL"];
      if (!IDENTIFIER_PATTERN.test(column) || !IDENTIFIER_PATTERN.test(referencedTable) ||
          !IDENTIFIER_PATTERN.test(referencedColumn) || !allowedActions.includes(onDelete)) {
        return res.status(400).json({ success: false, message: "Provide valid source and referenced columns and a supported delete action." });
      }
      const [sourceColumn, targetTable, targetColumn] = await Promise.all([
        pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [table.schemaName, tableName, column]),
        pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, [table.schemaName, referencedTable]),
        pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [table.schemaName, referencedTable, referencedColumn]),
      ]);
      if (!sourceColumn.rowCount || !targetTable.rowCount || !targetColumn.rowCount) {
        return res.status(400).json({ success: false, message: "The selected source or referenced table column does not exist in this database resource." });
      }
      await pool.query(
        `ALTER TABLE ${quote(table.schemaName)}.${quote(tableName)}
         ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${quote(column)})
         REFERENCES ${quote(table.schemaName)}.${quote(referencedTable)} (${quote(referencedColumn)})
         ON DELETE ${onDelete}`
      );
    } else if (type === "check") {
      const column = typeof body.column === "string" ? body.column : "";
      if (!IDENTIFIER_PATTERN.test(column) || !Object.prototype.hasOwnProperty.call(body, "value")) {
        return res.status(400).json({ success: false, message: "Provide a valid column and scalar CHECK value." });
      }
      const existing = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [table.schemaName, tableName, column]
      );
      if (!existing.rowCount) {
        return res.status(400).json({ success: false, message: "The CHECK constraint column does not exist in this table." });
      }
      const statement = buildCheckConstraintSql({
        schemaName: table.schemaName,
        tableName,
        constraintName: name,
        column,
        operator: typeof body.operator === "string" ? body.operator : "",
        value: body.value,
      });
      await pool.query(statement);
    } else {
      return res.status(400).json({ success: false, message: "Constraint type must be unique, foreign_key or check." });
    }

    return res.status(201).json({ success: true, message: "Constraint created." });
  } catch (error) {
    return sendError(error, res);
  }
});

// Drop a constraint only from the selected table.
router.delete("/:resourceId/tables/:tableName/constraints/:constraintName", async (req, res) => {
  const { projectId = "", resourceId = "", tableName = "", constraintName = "" } = params(req);
  if (!IDENTIFIER_PATTERN.test(constraintName)) {
    return res.status(400).json({ success: false, message: "Invalid constraint name." });
  }
  try {
    const table = await resolveTable(projectId, resourceId, tableName);
    if (!table.ok) return sendResolveError(table, res);
    const result = await pool.query(
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = $1 AND rel.relname = $2 AND con.conname = $3
         AND con.contype IN ('u', 'f', 'c')`,
      [table.schemaName, tableName, constraintName]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Removable unique, foreign-key or check constraint not found." });
    }
    await pool.query(`ALTER TABLE ${quote(table.schemaName)}.${quote(tableName)} DROP CONSTRAINT ${quote(constraintName)}`);
    return res.json({ success: true, message: "Constraint deleted." });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;
