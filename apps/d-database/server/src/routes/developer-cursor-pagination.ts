import { Router } from "express";
import { pool } from "../config/database.js";
import { requireDeveloperScope } from "../middleware/require-developer-key.js";
import {
  buildPrimaryKeyCursorQuery,
  CursorValidationError,
  encodePrimaryKeyCursor,
} from "../services/cursor-pagination.js";

const router = Router({ mergeParams: true });
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

// Keyset pagination is deterministic and avoids increasingly expensive OFFSET scans.
router.get("/tables/:tableName/rows/cursor", requireDeveloperScope("read"), async (req, res) => {
  const rawTable = req.params.tableName;
  const tableName = typeof rawTable === "string" ? rawTable : "";
  if (!IDENTIFIER.test(tableName)) return res.status(400).json({ success: false, message: "Invalid table name." });
  const limit = Number(req.query.limit ?? 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  if (req.query.cursor !== undefined && cursor === undefined) {
    return res.status(400).json({ success: false, message: "Provide one valid cursor value." });
  }

  const key = res.locals.developerKey as { schema_name: string };
  try {
    const primaryKeyResult = await pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.table_schema = $1 AND tc.table_name = $2
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [key.schema_name, tableName],
    );
    if (primaryKeyResult.rowCount === 0) return res.status(409).json({ success: false, message: "Cursor pagination requires a primary key." });
    if (primaryKeyResult.rowCount !== 1) return res.status(409).json({ success: false, message: "Cursor pagination currently requires exactly one primary-key column." });

    const query = buildPrimaryKeyCursorQuery({
      schemaName: key.schema_name,
      tableName,
      primaryKey: primaryKeyResult.rows[0].column_name as string,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const result = await pool.query(query.text, query.values);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const primaryKey = primaryKeyResult.rows[0].column_name as string;
    const nextCursor = hasMore && rows.length
      ? encodePrimaryKeyCursor(rows[rows.length - 1][primaryKey])
      : null;
    return res.json({ success: true, table: tableName, limit, rows, hasMore, nextCursor });
  } catch (error) {
    if (error instanceof CursorValidationError) return res.status(400).json({ success: false, message: error.message });
    console.error("Developer cursor page failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not read the next database page." });
  }
});

export default router;
