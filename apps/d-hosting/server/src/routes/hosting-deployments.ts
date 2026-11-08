import { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { getWebsiteFileCandidates } from "../services/website-file-resolution.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageRoot = path.resolve(process.env.HOSTING_STORAGE_ROOT || path.join(process.cwd(), "storage", "sites"));

type ManifestFile = {
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string | number;
};

function params(req: { params: object }) {
  return req.params as Record<string, string>;
}

async function ownedResource(projectId: string, resourceId: string, userId: string) {
  return pool.query(
    `SELECT r.id, r.project_id, r.status
     FROM hosting_resources r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
     LIMIT 1`,
    [resourceId, projectId, userId]
  );
}

// Return deployment attempts newest first.
router.get("/:resourceId/deployments", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const resource = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (resource.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT id, project_id, resource_id, deployment_number, status,
              file_manifest, error_summary, started_at, finished_at, created_at
       FROM hosting_deployments
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY deployment_number DESC
       LIMIT 20`,
      [projectId, resourceId]
    );

    return res.json({ success: true, deployments: result.rows });
  } catch (error) {
    console.error("Deployment history error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not load deployment history." });
  }
});

// Validate the uploaded static website and save an immutable file-reference manifest.
router.post("/:resourceId/deployments", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  const client = await pool.connect();
  let deploymentId: string | null = null;

  try {
    await client.query("BEGIN");

    const resource = await client.query(
      `SELECT r.id, r.project_id, r.status
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, String(res.locals.userId || "")]
    );

    if (resource.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    if (resource.rows[0].status === "archived") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Restore this website before deploying." });
    }

    const files = await client.query(
      `SELECT original_name, storage_key, mime_type, size_bytes
       FROM hosting_files
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY original_name ASC`,
      [projectId, resourceId]
    );

    const manifest = files.rows as ManifestFile[];
    const candidates = getWebsiteFileCandidates("index.html", manifest.map(file => file.original_name));
    const homepage = candidates.find(candidate => manifest.some(file => file.original_name === candidate));
    let failure = "";

    if (!homepage) {
      failure = "Deployment failed: upload an index.html homepage at the website root.";
    } else {
      const missing = manifest.find(file =>
        !UUID_PATTERN.test(file.storage_key) ||
        !existsSync(path.join(storageRoot, resourceId, file.storage_key))
      );
      if (missing) failure = `Deployment failed: stored file is missing (${missing.original_name}).`;
    }

    const numberResult = await client.query(
      `SELECT COALESCE(MAX(deployment_number), 0) + 1 AS next_number
       FROM hosting_deployments
       WHERE resource_id = $1`,
      [resourceId]
    );
    const deploymentNumber = Number(numberResult.rows[0].next_number);

    const inserted = await client.query(
      `INSERT INTO hosting_deployments
         (project_id, resource_id, deployment_number, status, file_manifest,
          error_summary, finished_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), $7)
       RETURNING id, project_id, resource_id, deployment_number, status,
                 file_manifest, error_summary, started_at, finished_at, created_at`,
      [
        projectId,
        resourceId,
        deploymentNumber,
        failure ? "failed" : "succeeded",
        JSON.stringify(failure ? [] : manifest),
        failure || null,
        String(res.locals.userId || ""),
      ]
    );

    deploymentId = inserted.rows[0].id;
    await client.query("COMMIT");

    return res.status(failure ? 422 : 201).json({
      success: !failure,
      message: failure || "Website files validated and deployment recorded.",
      deployment: inserted.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Deployment creation error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not complete this deployment." });
  } finally {
    client.release();
  }
});

export default router;
