import { Router } from "express";
import { pool } from "../config/database.js";
import { restoreDatabaseBackup } from "../services/database-backup-restore.js";

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


router.post("/:resourceId/backups/:backupId/restore", async (req, res) => {
  const params = req.params as Record<string, string>;
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const backupId = params.backupId || "";
  if (![projectId, resourceId, backupId].every((value) => UUID.test(value))) {
    return res.status(400).json({ success: false, message: "Invalid project, resource, or backup ID." });
  }
  const userId = res.locals.userId as string | undefined;
  if (!userId || !UUID.test(userId)) {
    return res.status(401).json({ success: false, message: "Authentication is required." });
  }
  try {
    await restoreDatabaseBackup({ projectId, resourceId, backupId, userId });
    return res.json({ success: true, message: "Database backup restored successfully. A verified safety backup was created first." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown restore error.";
    const notFound = message.includes("not found") || message.includes("completed, unexpired backup");
    const conflict = message.includes("not configured") || message.includes("checksum") || message.includes("integrity") || message.includes("safety backup") || message.includes("ownership validation");
    console.error("D Database restore failed:", message);
    return res.status(notFound ? 404 : conflict ? 409 : 500).json({
      success: false,
      message: notFound || conflict ? message : "Database restore failed. The existing safety backup has been retained where possible.",
    });
  }
});

export default router;
