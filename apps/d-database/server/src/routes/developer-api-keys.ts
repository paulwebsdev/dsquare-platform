import { Router, type Request } from "express";
import { pool } from "../config/database.js";
import { createDeveloperApiKeyMaterial } from "../services/developer-api-key.js";

const router = Router({ mergeParams: true });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validIds(projectId: string, resourceId: string) {
  return UUID_PATTERN.test(projectId) && UUID_PATTERN.test(resourceId);
}

// List key metadata only. Secret values are never returned after creation.
router.get("/", async (req: Request<{ projectId: string; resourceId: string }>, res) => {
  const { projectId = "", resourceId = "" } = req.params;
  if (!validIds(projectId, resourceId)) return res.status(400).json({ success: false, message: "Invalid project or resource ID." });

  try {
    const result = await pool.query(
      `SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM developer_api_keys
       WHERE project_id = $1 AND resource_id = $2 AND user_id = $3
       ORDER BY created_at DESC`,
      [projectId, resourceId, res.locals.userId],
    );
    return res.json({ success: true, keys: result.rows });
  } catch (error) {
    console.error("Developer key list failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not load API keys." });
  }
});

// Create a resource-bound key. The raw key is returned once only.
router.post("/", async (req: Request<{ projectId: string; resourceId: string }>, res) => {
  const { projectId = "", resourceId = "" } = req.params;
  if (!validIds(projectId, resourceId)) return res.status(400).json({ success: false, message: "Invalid project or resource ID." });

  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const scopes = body?.scopes;
  const expiresInDays = body?.expiresInDays;

  if (!name || name.length > 80) return res.status(400).json({ success: false, message: "Key name must contain 1–80 characters." });
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.some((scope) => scope !== "read" && scope !== "write")) {
    return res.status(400).json({ success: false, message: "Choose read, write, or both permissions." });
  }
  if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || Number(expiresInDays) < 1 || Number(expiresInDays) > 365)) {
    return res.status(400).json({ success: false, message: "Expiry must be between 1 and 365 days." });
  }

  try {
    const resource = await pool.query(
      `SELECT r.id FROM database_resources r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3 AND r.status = 'active'`,
      [resourceId, projectId, res.locals.userId],
    );
    if (resource.rowCount !== 1) return res.status(404).json({ success: false, message: "Active database resource not found." });

    const { secret: token, tokenHash, prefix } = createDeveloperApiKeyMaterial();
    const expiry = expiresInDays === undefined ? null : Number(expiresInDays);

    const created = await pool.query(
      `INSERT INTO developer_api_keys
         (user_id, project_id, resource_id, name, key_prefix, token_hash, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::integer IS NULL THEN NULL ELSE NOW() + ($8 * INTERVAL '1 day') END)
       RETURNING id, name, key_prefix, scopes, created_at, expires_at`,
      [res.locals.userId, projectId, resourceId, name, prefix, tokenHash, [...new Set(scopes)], expiry],
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({
      success: true,
      message: "API key created. Copy it now; it will not be shown again.",
      key: created.rows[0],
      secret: token,
    });
  } catch (error) {
    console.error("Developer key creation failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not create the API key." });
  }
});

// Rotate a resource-bound key atomically. The old key is revoked only after the replacement is stored.
router.post("/:keyId/rotate", async (req: Request<{ projectId: string; resourceId: string; keyId: string }>, res) => {
  const { projectId = "", resourceId = "", keyId = "" } = req.params;
  if (!validIds(projectId, resourceId) || !UUID_PATTERN.test(keyId)) {
    return res.status(400).json({ success: false, message: "Invalid project, resource, or key ID." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT k.name, k.scopes, k.expires_at
       FROM developer_api_keys k
       JOIN projects p ON p.id = k.project_id AND p.owner_id = k.user_id AND p.status = 'active'
       JOIN database_resources r ON r.id = k.resource_id AND r.project_id = k.project_id AND r.status = 'active'
       WHERE k.id = $1 AND k.project_id = $2 AND k.resource_id = $3
         AND k.user_id = $4 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > NOW())
       FOR UPDATE OF k`,
      [keyId, projectId, resourceId, res.locals.userId],
    );

    if (current.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Active, unexpired API key not found." });
    }

    const { secret: token, tokenHash, prefix } = createDeveloperApiKeyMaterial();
    const previous = current.rows[0] as { name: string; scopes: string[]; expires_at: Date | string | null };

    const created = await client.query(
      `INSERT INTO developer_api_keys
         (user_id, project_id, resource_id, name, key_prefix, token_hash, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, key_prefix, scopes, created_at, expires_at`,
      [res.locals.userId, projectId, resourceId, previous.name, prefix, tokenHash, previous.scopes, previous.expires_at],
    );

    await client.query(
      "UPDATE developer_api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL",
      [keyId],
    );
    await client.query("COMMIT");

    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({
      success: true,
      message: "API key rotated. The previous key has been revoked; update your application with the new secret.",
      key: created.rows[0],
      secret: token,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Developer key rotation failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not rotate the API key." });
  } finally {
    client.release();
  }
});

// Revoke a key without deleting its audit metadata.
router.delete("/:keyId", async (req: Request<{ projectId: string; resourceId: string; keyId: string }>, res) => {
  const { projectId = "", resourceId = "", keyId = "" } = req.params;
  if (!validIds(projectId, resourceId) || !UUID_PATTERN.test(keyId)) {
    return res.status(400).json({ success: false, message: "Invalid project, resource, or key ID." });
  }

  try {
    const result = await pool.query(
      `UPDATE developer_api_keys
       SET revoked_at = NOW()
       WHERE id = $1 AND project_id = $2 AND resource_id = $3
         AND user_id = $4 AND revoked_at IS NULL
       RETURNING id`,
      [keyId, projectId, resourceId, res.locals.userId],
    );
    if (result.rowCount !== 1) return res.status(404).json({ success: false, message: "Active API key not found." });
    return res.json({ success: true, message: "API key revoked." });
  } catch (error) {
    console.error("Developer key revocation failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not revoke the API key." });
  }
});

export default router;
