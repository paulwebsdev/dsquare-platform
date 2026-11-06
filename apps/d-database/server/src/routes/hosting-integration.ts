import { Router } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = Router();
const CLIENT_ID = process.env.D_HOSTING_INTEGRATION_CLIENT_ID || "dsquare-d-hosting";
const CLIENT_SECRET = process.env.D_HOSTING_INTEGRATION_CLIENT_SECRET || "";
const CALLBACK_URL = process.env.D_HOSTING_CALLBACK_URL || "http://127.0.0.1:5174/integrations/database/callback";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

router.post("/authorize", async (req, res) => {
  const state = typeof req.body?.state === "string" ? req.body.state : "";
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
  const resourceId = typeof req.body?.resourceId === "string" ? req.body.resourceId : "";

  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !uuidPattern.test(projectId) || !uuidPattern.test(resourceId)) {
    res.status(400).json({ success: false, message: "Invalid authorization request." });
    return;
  }

  try {
    const resource = await pool.query(
      `SELECT r.id FROM database_resources r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
         AND p.status = 'active' AND r.status = 'active'`,
      [resourceId, projectId, res.locals.userId],
    );

    if (resource.rowCount !== 1) {
      res.status(404).json({ success: false, message: "Active database resource not found in your account." });
      return;
    }

    const code = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO hosting_authorization_codes
       (code_hash, client_id, user_id, project_id, resource_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '5 minutes')`,
      [sha256(code), CLIENT_ID, res.locals.userId, projectId, resourceId],
    );

    const callback = new URL(CALLBACK_URL);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    res.json({ success: true, redirectUrl: callback.toString() });
  } catch (error) {
    console.error("D Hosting authorization error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to approve this connection." });
  }
});

router.post("/redeem", async (req, res) => {
  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : "";
  const clientSecret = typeof req.body?.clientSecret === "string" ? req.body.clientSecret : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const expected = Buffer.from(CLIENT_SECRET);
  const supplied = Buffer.from(clientSecret);
  const secretValid = expected.length > 0 && expected.length === supplied.length && timingSafeEqual(expected, supplied);

  if (!secretValid || clientId !== CLIENT_ID) {
    res.status(401).json({ success: false, message: "Invalid integration client." });
    return;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    res.status(400).json({ success: false, message: "Invalid authorization code." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consumed = await client.query(
      `UPDATE hosting_authorization_codes SET consumed_at = NOW()
       WHERE code_hash = $1 AND client_id = $2
         AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING user_id, project_id, resource_id`,
      [sha256(code), CLIENT_ID],
    );
    if (consumed.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: "Authorization code is invalid, expired, or already used." });
      return;
    }

    const approved = await client.query(
      `SELECT c.user_id, c.project_id, c.resource_id, r.name AS resource_name
       FROM hosting_authorization_codes c
       JOIN projects p ON p.id = c.project_id AND p.owner_id = c.user_id
       JOIN database_resources r ON r.id = c.resource_id AND r.project_id = c.project_id
       WHERE c.code_hash = $1`,
      [sha256(code)],
    );
    if (approved.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: "Approved resource is no longer available." });
      return;
    }
    await client.query("COMMIT");
    res.json({ success: true, connection: approved.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("D Hosting code redemption error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to redeem authorization code." });
  } finally {
    client.release();
  }
});

router.use(requireAuth);

export default router;
