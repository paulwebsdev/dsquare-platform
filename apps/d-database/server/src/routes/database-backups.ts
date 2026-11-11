import { Router } from "express";
import { pool } from "../config/database.js";

const router = Router({ mergeParams: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/:resourceId/backups", async (req, res) => {
  const params = req.params as Record<string, string>;
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  if (!UUID.test(projectId) || !UUID.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or resource ID." });
  }

  const limit = Number(req.query.limit ?? 25);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
    return res.status(400).json({ success: false, message: "Limit must be 1–100 and offset must be a non-negative integer." });
  }

  try {
    const resource = await pool.query(
      "SELECT id FROM database_resources WHERE id = $1 AND project_id = $2",
      [resourceId, projectId],
    );
    if (resource.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Database resource not found." });
    }

    const result = await pool.query(
      `SELECT id, project_id, resource_id, provider, checksum_sha256,
              size_bytes, status, error_code, started_at, completed_at,
              expires_at, restored_at, created_at
       FROM database_backups
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [projectId, resourceId, limit, offset],
    );

    return res.json({
      success: true,
      limit,
      offset,
      backups: result.rows,
    });
  } catch (error) {
    console.error("D Database backup history failed:", error instanceof Error ? error.message : "Unknown error");
    return res.status(500).json({ success: false, message: "Could not load backup history." });
  }
});

export default router;
