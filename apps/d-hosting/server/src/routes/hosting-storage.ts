import { Router, type Request, type Response } from "express";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import {
  createRuntimeAgentStorageBackup, deleteRuntimeAgentStorageBackup,
  getRuntimeAgentStorageUsage, getRuntimeAgentRuntime,
  listRuntimeAgentStorageBackups, restoreRuntimeAgentStorageBackup,
  tombstoneRuntimeAgentStorage,
} from "../services/runtime-agent-client.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_ID = /^[a-f0-9]{32}$/;

function agentOptions() {
  const baseUrl = process.env.D_HOSTING_RUNTIME_AGENT_URL?.trim();
  const secret = process.env.D_HOSTING_RUNTIME_AGENT_SECRET;
  return baseUrl && secret ? { baseUrl, secret } : null;
}
async function ownedResource(projectId: string, resourceId: string, userId: string) {
  return pool.query(
    `SELECT r.id, r.site_type, r.status, r.active_deployment_id
     FROM hosting_resources r
     INNER JOIN projects p ON p.id=r.project_id
     WHERE r.id=$1 AND r.project_id=$2 AND p.owner_id=$3 LIMIT 1`,
    [resourceId, projectId, userId],
  );
}
async function authorize(req: Request, res: Response) {
  const projectId = String(req.params.projectId || "");
  const resourceId = String(req.params.resourceId || "");
  if (!UUID.test(projectId) || !UUID.test(resourceId)) {
    res.status(400).json({ success: false, message: "Invalid project or website ID." });
    return null;
  }
  const result = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
  if (result.rowCount !== 1) {
    res.status(404).json({ success: false, message: "Website resource not found." });
    return null;
  }
  if (result.rows[0].site_type !== "node") {
    res.status(409).json({ success: false, message: "Persistent runtime storage controls are available for Node.js websites." });
    return null;
  }
  const agent = agentOptions();
  if (!agent) {
    res.status(503).json({ success: false, message: "The private runtime agent is not configured." });
    return null;
  }
  return { resource: result.rows[0] as { id: string; site_type: string; status: string; active_deployment_id: string | null }, agent };
}

router.get("/:resourceId/storage/usage", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    const usage = await getRuntimeAgentStorageUsage(access.agent, req.params.resourceId);
    return res.json({ success: true, resourceId: req.params.resourceId, ...usage });
  } catch (error) {
    console.error("Persistent storage usage request failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent storage usage is unavailable." });
  }
});

router.get("/:resourceId/storage/backups", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    const backups = await listRuntimeAgentStorageBackups(access.agent, req.params.resourceId);
    return res.json({ success: true, resourceId: req.params.resourceId, backups });
  } catch (error) {
    console.error("Persistent backup history request failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent backup history is unavailable." });
  }
});

router.post("/:resourceId/storage/backups", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    if (access.resource.status === "archived") return res.status(409).json({ success: false, message: "Restore this website before creating a backup." });
    const backup = await createRuntimeAgentStorageBackup(access.agent, req.params.resourceId, String(res.locals.userId));
    return res.status(201).json({ success: true, backup });
  } catch (error) {
    console.error("Persistent backup creation failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent backup could not be created." });
  }
});

router.post("/:resourceId/storage/backups/:backupId/restore", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    const backupId = String(req.params.backupId || "");
    if (!BACKUP_ID.test(backupId)) return res.status(400).json({ success: false, message: "Invalid backup ID." });
    if (access.resource.active_deployment_id && UUID.test(access.resource.active_deployment_id)) {
      const runtime = await getRuntimeAgentRuntime(access.agent, req.params.resourceId, access.resource.active_deployment_id);
      if (runtime.state === "running") return res.status(409).json({ success: false, message: "Stop the website runtime before restoring persistent data." });
    }
    const restored = await restoreRuntimeAgentStorageBackup(access.agent, req.params.resourceId, backupId, String(res.locals.userId));
    return res.json({ success: true, resourceId: req.params.resourceId, ...restored });
  } catch (error) {
    console.error("Persistent backup restore failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent backup could not be restored." });
  }
});

router.delete("/:resourceId/storage/backups/:backupId", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    const backupId = String(req.params.backupId || "");
    if (!BACKUP_ID.test(backupId)) return res.status(400).json({ success: false, message: "Invalid backup ID." });
    await deleteRuntimeAgentStorageBackup(access.agent, req.params.resourceId, backupId, String(res.locals.userId));
    return res.json({ success: true, backupId, deleted: true });
  } catch (error) {
    console.error("Persistent backup deletion failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent backup could not be deleted." });
  }
});

router.post("/:resourceId/storage/tombstone", async (req, res) => {
  try {
    const access = await authorize(req, res); if (!access) return;
    if (access.resource.status !== "archived") return res.status(409).json({ success: false, message: "Archive the website before tombstoning its persistent data." });
    if (access.resource.active_deployment_id && UUID.test(access.resource.active_deployment_id)) {
      const runtime = await getRuntimeAgentRuntime(access.agent, req.params.resourceId, access.resource.active_deployment_id);
      if (runtime.state === "running") return res.status(409).json({ success: false, message: "Stop the website runtime before tombstoning persistent data." });
    }
    const result = await tombstoneRuntimeAgentStorage(access.agent, req.params.resourceId, String(res.locals.userId));
    return res.json({ success: true, resourceId: req.params.resourceId, ...result });
  } catch (error) {
    console.error("Persistent storage tombstone failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Persistent website data could not be tombstoned." });
  }
});

export default router;
