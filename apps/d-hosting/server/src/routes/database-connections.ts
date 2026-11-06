import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const router = Router();
router.use(requireAuth);

const limitConnectionStart = createRateLimiter(10, 60_000);
const limitConnectionComplete = createRateLimiter(10, 60_000);

const APP_ORIGIN = process.env.D_HOSTING_APP_ORIGIN || "http://127.0.0.1:5174";
function requireSameOrigin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  if (req.get("origin") !== APP_ORIGIN) {
    res.status(403).json({ success: false, message: "Request origin is not allowed." });
    return;
  }
  next();
}

const CLIENT_ID = process.env.D_HOSTING_INTEGRATION_CLIENT_ID || "dsquare-d-hosting";
const CLIENT_SECRET = process.env.D_HOSTING_INTEGRATION_CLIENT_SECRET || "";
const DATABASE_API_URL = process.env.D_DATABASE_API_URL || "http://127.0.0.1:5001";

function getDatabaseAppUrl(): URL {
  const configured = process.env.D_DATABASE_APP_URL?.trim();
  const value = configured || (
    process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5173"
  );

  if (!value) {
    throw new Error("D_DATABASE_APP_URL must be set in production.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("D_DATABASE_APP_URL must be a valid origin.");
  }

  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);

  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (process.env.NODE_ENV === "production"
      ? parsed.protocol !== "https:"
      : parsed.protocol !== "https:" && !isLoopbackHttp)
  ) {
    throw new Error("D_DATABASE_APP_URL must be a secure HTTPS origin (HTTP loopback is allowed only in development).");
  }

  return parsed;
}

const DATABASE_APP_URL = getDatabaseAppUrl();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

router.post("/start", requireSameOrigin, limitConnectionStart, async (_req, res) => {
  if (!CLIENT_SECRET) {
    res.status(503).json({ success: false, message: "Database integration is not configured." });
    return;
  }
  try {
    const state = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO database_connection_requests (state_hash, hosting_user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
      [sha256(state), res.locals.userId],
    );
    const approval = new URL("/integrations/hosting/approve", DATABASE_APP_URL);
    approval.searchParams.set("state", state);
    approval.searchParams.set("client_id", CLIENT_ID);
    res.status(201).json({ success: true, authorizationUrl: approval.toString() });
  } catch (error) {
    console.error("Database connection start error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to start database connection." });
  }
});

router.post("/complete", requireSameOrigin, limitConnectionComplete, async (req, res) => {
  const state = typeof req.body?.state === "string" ? req.body.state : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    res.status(400).json({ success: false, message: "Invalid connection response." });
    return;
  }
  if (!CLIENT_SECRET) {
    res.status(503).json({ success: false, message: "Database integration is not configured." });
    return;
  }

  let databaseApiUrl: URL;
  try {
    databaseApiUrl = new URL(DATABASE_API_URL);
    const isLoopbackHttp =
      databaseApiUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(databaseApiUrl.hostname);
    if (
      databaseApiUrl.username ||
      databaseApiUrl.password ||
      databaseApiUrl.search ||
      databaseApiUrl.hash ||
      (process.env.NODE_ENV === "production"
        ? databaseApiUrl.protocol !== "https:"
        : databaseApiUrl.protocol !== "https:" && !isLoopbackHttp)
    ) {
      throw new Error("D Database API URL is not secure.");
    }
  } catch {
    res.status(503).json({ success: false, message: "D Database API URL is not configured safely." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT id FROM database_connection_requests
       WHERE state_hash = $1 AND hosting_user_id = $2
         AND completed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [sha256(state), res.locals.userId],
    );
    if (pending.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: "Connection request expired or already used." });
      return;
    }

    const response = await fetch(new URL("/api/v1/integrations/hosting/redeem", databaseApiUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json() as {
      success?: boolean;
      connection?: { user_id: string; project_id: string; resource_id: string; resource_name: string };
    };
    if (!response.ok || !payload.success || !payload.connection) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: "D Database could not verify this authorization." });
      return;
    }

    const item = payload.connection;
    if (!validId(item.user_id) || !validId(item.project_id) || !validId(item.resource_id) || typeof item.resource_name !== "string") {
      await client.query("ROLLBACK");
      res.status(502).json({ success: false, message: "D Database returned an invalid approval response." });
      return;
    }

    const saved = await client.query(
      `INSERT INTO database_connections
       (hosting_user_id, database_user_id, database_project_id, database_resource_id, resource_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hosting_user_id, database_resource_id) WHERE status = 'active'
       DO NOTHING
       RETURNING id, resource_name, status, connected_at`,
      [res.locals.userId, item.user_id, item.project_id, item.resource_id, item.resource_name.slice(0, 80)],
    );
    if (saved.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(409).json({ success: false, message: "This database resource is already connected." });
      return;
    }

    await client.query("UPDATE database_connection_requests SET completed_at = NOW() WHERE id = $1", [pending.rows[0].id]);
    await client.query("COMMIT");
    res.json({ success: true, connection: saved.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Database connection completion error:", error instanceof Error ? error.message : error);
    res.status(502).json({ success: false, message: "Unable to complete database connection." });
  } finally {
    client.release();
  }
});

router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, database_project_id, database_resource_id, resource_name, status, connected_at, revoked_at
       FROM database_connections WHERE hosting_user_id = $1 ORDER BY connected_at DESC`,
      [res.locals.userId],
    );
    res.json({ success: true, count: result.rowCount, connections: result.rows });
  } catch (error) {
    console.error("Database connection list error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to list database connections." });
  }
});

router.delete("/:connectionId", requireSameOrigin, async (req, res) => {
  const connectionId = req.params.connectionId;
  if (typeof connectionId !== "string" || !validId(connectionId)) {
    res.status(400).json({ success: false, message: "Invalid connection ID." });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE database_connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE id = $1 AND hosting_user_id = $2 AND status = 'active'
       RETURNING id, status, revoked_at`,
      [connectionId, res.locals.userId],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ success: false, message: "Active connection not found." });
      return;
    }
    res.json({ success: true, connection: result.rows[0] });
  } catch (error) {
    console.error("Database connection revoke error:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Unable to revoke database connection." });
  }
});

export default router;
