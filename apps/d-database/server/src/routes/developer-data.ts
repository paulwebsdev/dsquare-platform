import { Router } from "express";
import { pool } from "../config/database.js";
import { requireDeveloperScope } from "../middleware/require-developer-key.js";

const router = Router({ mergeParams: true });
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

// List tables visible inside the API key's single database resource.
router.get("/tables", requireDeveloperScope("read"), async (_req, res) => {
  const key = res.locals.developerKey as { schema_name: string };
  try {
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [key.schema_name],
    );
    return res.json({ success: true, tables: result.rows.map((row) => row.table_name) });
  } catch (error) {
    console.error("Developer table listing failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not list database tables." });
  }
});

// Read paginated rows from one table. Arbitrary SQL is never accepted.
router.get("/tables/:tableName/rows", requireDeveloperScope("read"), async (req, res) => {
  const rawTableName = req.params.tableName;
  const tableName = typeof rawTableName === "string" ? rawTableName : "";
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  if (!IDENTIFIER_PATTERN.test(tableName)) return res.status(400).json({ success: false, message: "Invalid table name." });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
    return res.status(400).json({ success: false, message: "Limit must be 1–100 and offset a non-negative integer." });
  }

  const key = res.locals.developerKey as { schema_name: string };
  try {
    const exists = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [key.schema_name, tableName],
    );
    if (exists.rowCount !== 1) return res.status(404).json({ success: false, message: "Table not found." });

    const table = `${quoteIdentifier(key.schema_name)}.${quoteIdentifier(tableName)}`;
    const [rows, count] = await Promise.all([
      pool.query(`SELECT * FROM ${table} LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query(`SELECT COUNT(*)::text AS total FROM ${table}`),
    ]);
    return res.json({ success: true, table: tableName, limit, offset, total: count.rows[0].total, rows: rows.rows });
  } catch (error) {
    console.error("Developer row read failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not read database rows." });
  }
});

// Insert a row using validated column names and parameterized values.
router.post("/tables/:tableName/rows", requireDeveloperScope("write"), async (req, res) => {
  const tableName = req.params.tableName || "";
  if (!IDENTIFIER_PATTERN.test(tableName)) return res.status(400).json({ success: false, message: "Invalid table name." });
  const body = req.body as Record<string, unknown>;
  const values = body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return res.status(400).json({ success: false, message: "Provide a values object." });

  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > 50 || entries.some(([name]) => !IDENTIFIER_PATTERN.test(name))) {
    return res.status(400).json({ success: false, message: "Provide 1–50 valid column values." });
  }

  const key = res.locals.developerKey as { schema_name: string };
  try {
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [key.schema_name, tableName],
    );
    const allowed = new Set(columns.rows.map((row) => row.column_name as string));
    if (columns.rowCount === 0) return res.status(404).json({ success: false, message: "Table not found." });
    if (entries.some(([name]) => !allowed.has(name))) return res.status(400).json({ success: false, message: "One or more columns do not exist in this table." });

    const table = `${quoteIdentifier(key.schema_name)}.${quoteIdentifier(tableName)}`;
    const names = entries.map(([name]) => quoteIdentifier(name));
    const placeholders = entries.map((_, index) => `$${index + 1}`);
    const result = await pool.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      entries.map(([, value]) => value),
    );
    return res.status(201).json({ success: true, row: result.rows[0] });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23505" || code === "23503" || code === "23502" || code === "23514") {
      return res.status(409).json({ success: false, message: "The row conflicts with a database constraint." });
    }
    console.error("Developer row insert failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not insert the database row." });
  }
});

export default router;
