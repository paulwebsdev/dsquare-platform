import { Router } from "express";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import {
  encryptEnvironmentSecret,
  isValidEnvironmentName,
} from "../services/environment-secrets.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routeParams(req: { params: object }) {
  return req.params as Record<string, string>;
}

async function getOwnedResource(projectId: string, resourceId: string, userId: string) {
  return pool.query(
    `SELECT r.id
     FROM hosting_resources r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
     LIMIT 1`,
    [resourceId, projectId, userId],
  );
}

router.get("/:resourceId/environment", async (req, res) => {
  const { projectId = "", resourceId = "" } = routeParams(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const owned = await getOwnedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT name, created_at, updated_at
       FROM hosting_environment_variables
       WHERE resource_id = $1
       ORDER BY name ASC`,
      [resourceId],
    );

    return res.json({
      success: true,
      variables: result.rows.map((row) => ({
        name: row.name,
        value: "••••••••",
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    });
  } catch (error) {
    console.error("Environment variable list error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not load environment variables." });
  }
});

router.put("/:resourceId/environment", async (req, res) => {
  const { projectId = "", resourceId = "" } = routeParams(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";

  if (!isValidEnvironmentName(name)) {
    return res.status(400).json({ success: false, message: "Use a valid environment variable name." });
  }
  if (!value || value.length > 16384) {
    return res.status(400).json({ success: false, message: "Environment variable values must contain 1–16,384 characters." });
  }

  try {
    const owned = await getOwnedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const encrypted = encryptEnvironmentSecret(value, process.env, `${resourceId}:${name}`);
    await pool.query(
      `INSERT INTO hosting_environment_variables
         (resource_id, name, encrypted_value, encryption_iv, encryption_auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (resource_id, name)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                     encryption_iv = EXCLUDED.encryption_iv,
                     encryption_auth_tag = EXCLUDED.encryption_auth_tag,
                     updated_at = NOW()`,
      [resourceId, name, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
    );

    return res.json({ success: true, message: "Environment variable saved." });
  } catch (error) {
    console.error("Environment variable save error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not save environment variable. Check the Hosting secrets key configuration." });
  }
});

router.delete("/:resourceId/environment/:name", async (req, res) => {
  const { projectId = "", resourceId = "", name = "" } = routeParams(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId) || !isValidEnvironmentName(name)) {
    return res.status(400).json({ success: false, message: "Invalid project, website, or variable name." });
  }

  try {
    const owned = await getOwnedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      "DELETE FROM hosting_environment_variables WHERE resource_id = $1 AND name = $2",
      [resourceId, name],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Environment variable not found." });
    }

    return res.json({ success: true, message: "Environment variable deleted." });
  } catch (error) {
    console.error("Environment variable delete error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not delete environment variable." });
  }
});

export default router;
