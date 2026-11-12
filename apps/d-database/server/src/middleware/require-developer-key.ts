import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../config/database.js";

export type DeveloperScope = "read" | "write";

export async function requireDeveloperKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorization = req.header("authorization") || "";
    const match = /^Bearer (dsq_live_[A-Za-z0-9_-]{40,})$/.exec(authorization);

    if (!match) {
      res.status(401).json({ success: false, message: "A valid D Database API key is required." });
      return;
    }

    const tokenHash = createHash("sha256").update(match[1]).digest("hex");
    const projectId = String(req.params.projectId || "");
    const resourceId = String(req.params.resourceId || "");

    const result = await pool.query<{
      id: string;
      project_id: string;
      resource_id: string;
      scopes: DeveloperScope[];
      resource_status: string;
      schema_name: string;
    }>(
      `SELECT k.id, k.project_id, k.resource_id, k.scopes,
              r.status AS resource_status, r.schema_name
       FROM developer_api_keys k
       JOIN projects p ON p.id = k.project_id AND p.owner_id = k.user_id
       JOIN database_resources r
         ON r.id = k.resource_id AND r.project_id = k.project_id
       WHERE k.token_hash = $1
         AND k.project_id = $2
         AND k.resource_id = $3
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
      [tokenHash, projectId, resourceId],
    );

    const key = result.rows[0];
    if (!key) {
      res.status(401).json({ success: false, message: "API key is invalid, expired, revoked, or outside its resource scope." });
      return;
    }

    if (key.resource_status !== "active" || !/^db_[a-f0-9]{32}$/.test(key.schema_name)) {
      res.status(409).json({ success: false, message: "The database resource is not active." });
      return;
    }

    await pool.query("UPDATE developer_api_keys SET last_used_at = NOW() WHERE id = $1", [key.id]);
    res.locals.developerKey = key;
    next();
  } catch (error) {
    console.error("Developer API key verification failed:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Could not verify the developer API key." });
  }
}

export function requireDeveloperScope(scope: DeveloperScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const key = res.locals.developerKey as { scopes?: DeveloperScope[] } | undefined;
    if (!key?.scopes?.includes(scope)) {
      res.status(403).json({ success: false, message: `This API key does not have the ${scope} permission.` });
      return;
    }
    next();
  };
}
