import { Router } from "express";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const validUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function ownsWebsite(projectId: string, resourceId: string, userId: string) {
  const result = await pool.query(
    `SELECT r.id
     FROM hosting_resources r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       AND r.site_type = 'node' AND r.status <> 'archived'`,
    [resourceId, projectId, userId],
  );
  return result.rowCount === 1;
}

router.get("/:resourceId/database-connection", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");
  if (!validUUID(projectId) || !validUUID(resourceId)) {
    res.status(400).json({ success: false, message: "Invalid project or website ID." });
    return;
  }
  try {
    if (!await ownsWebsite(projectId, resourceId, res.locals.userId)) {
      res.status(404).json({ success: false, message: "Node.js website not found." });
      return;
    }
    const [connections, assigned] = await Promise.all([
      pool.query(
        `SELECT id, database_resource_id, resource_name, connected_at
         FROM database_connections
         WHERE hosting_user_id = $1 AND status = 'active'
         ORDER BY connected_at DESC`,
        [res.locals.userId],
      ),
      pool.query(
        `SELECT m.database_connection_id AS connection_id
         FROM hosting_resource_database_connections m
         INNER JOIN database_connections c ON c.id = m.database_connection_id
         WHERE m.hosting_resource_id = $1 AND m.hosting_user_id = $2
           AND c.hosting_user_id = $2 AND c.status = 'active'`,
        [resourceId, res.locals.userId],
      ),
    ]);
    res.json({
      success: true,
      connections: connections.rows,
      assignedConnectionId: assigned.rows[0]?.connection_id ?? null,
    });
  } catch (error) {
    console.error("Website database assignment read error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to load website database settings." });
  }
});

router.put("/:resourceId/database-connection", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");
  const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : "";
  if (!validUUID(projectId) || !validUUID(resourceId) || !validUUID(connectionId)) {
    res.status(400).json({ success: false, message: "A valid database connection must be selected." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const website = await client.query(
      `SELECT r.id FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
         AND r.site_type = 'node' AND r.status <> 'archived'
       FOR UPDATE OF r`,
      [resourceId, projectId, res.locals.userId],
    );
    if (website.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ success: false, message: "Node.js website not found." });
      return;
    }
    const connection = await client.query(
      `SELECT id FROM database_connections
       WHERE id = $1 AND hosting_user_id = $2 AND status = 'active'`,
      [connectionId, res.locals.userId],
    );
    if (connection.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ success: false, message: "Active database connection not found for this account." });
      return;
    }
    await client.query(
      `INSERT INTO hosting_resource_database_connections
       (hosting_user_id, hosting_resource_id, database_connection_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (hosting_resource_id)
       DO UPDATE SET database_connection_id = EXCLUDED.database_connection_id,
                     hosting_user_id = EXCLUDED.hosting_user_id,
                     updated_at = NOW()`,
      [res.locals.userId, resourceId, connectionId],
    );
    await client.query("COMMIT");
    res.json({ success: true, message: "Database assigned to this website.", assignedConnectionId: connectionId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Website database assignment save error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to assign this database to the website." });
  } finally {
    client.release();
  }
});

router.delete("/:resourceId/database-connection", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");
  if (!validUUID(projectId) || !validUUID(resourceId)) {
    res.status(400).json({ success: false, message: "Invalid project or website ID." });
    return;
  }
  try {
    if (!await ownsWebsite(projectId, resourceId, res.locals.userId)) {
      res.status(404).json({ success: false, message: "Node.js website not found." });
      return;
    }
    const result = await pool.query(
      `DELETE FROM hosting_resource_database_connections
       WHERE hosting_resource_id = $1 AND hosting_user_id = $2`,
      [resourceId, res.locals.userId],
    );
    res.json({ success: true, disconnected: result.rowCount === 1 });
  } catch (error) {
    console.error("Website database assignment removal error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to remove the website database assignment." });
  }
});

export default router;
