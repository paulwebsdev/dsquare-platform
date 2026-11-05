import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../config/database.js";

const router = Router({ mergeParams: true });

const validUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function sendError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;

  if (code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A resource with this name already exists in this project.",
    });
  }

  console.error(
    "D Database resource error:",
    error instanceof Error ? error.message : error
  );

  return res.status(500).json({
    success: false,
    message: "Could not complete the resource operation.",
  });
}

router.get("/", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");

  if (!validUUID(projectId)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  try {
    const project = await pool.query(
      "SELECT id FROM projects WHERE id = $1",
      [projectId]
    );

    if (project.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Project not found." });
    }

    const includeArchived = req.query.includeArchived === "true";

    const result = await pool.query(
      `SELECT id, project_id, name, engine, schema_name, status, created_at, updated_at
       FROM database_resources
       WHERE project_id = $1
         AND ($2::boolean OR status = 'active')
       ORDER BY created_at DESC`,
      [projectId, includeArchived]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      resources: result.rows,
    });
  } catch (error) {
    return sendError(error, res);
  }
});

router.post("/", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");

  if (!validUUID(projectId)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!name || name.length > 80) {
    return res.status(400).json({
      success: false,
      message: "Resource name must contain between 1 and 80 characters.",
    });
  }

  const id = randomUUID();
  const schemaName = `db_${id.replace(/-/g, "")}`;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const project = await client.query(
      "SELECT id FROM projects WHERE id = $1 FOR SHARE",
      [projectId]
    );

    if (project.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Project not found.",
      });
    }

    // The schema identifier is generated from a UUID, never from user input.
    await client.query(`CREATE SCHEMA "${schemaName}"`);

    const result = await client.query(
      `INSERT INTO database_resources
        (id, project_id, name, engine, schema_name)
       VALUES ($1, $2, $3, 'postgresql', $4)
       RETURNING id, project_id, name, engine, schema_name, status, created_at, updated_at`,
      [id, projectId, name, schemaName]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "PostgreSQL resource created successfully.",
      resource: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return sendError(error, res);
  } finally {
    client.release();
  }
});

router.get("/:resourceId", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");

  if (!validUUID(projectId) || !validUUID(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid resource or project ID." });
  }

  try {
    const result = await pool.query(
      `SELECT id, project_id, name, engine, schema_name, status, created_at, updated_at
       FROM database_resources
       WHERE id = $1 AND project_id = $2`,
      [resourceId, projectId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Resource not found." });
    }

    return res.json({ success: true, resource: result.rows[0] });
  } catch (error) {
    return sendError(error, res);
  }
});

router.patch("/:resourceId", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");

  if (!validUUID(projectId) || !validUUID(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid resource or project ID." });
  }

  const body = req.body as Record<string, unknown>;
  const hasName = Object.prototype.hasOwnProperty.call(body || {}, "name");
  const hasStatus = Object.prototype.hasOwnProperty.call(body || {}, "status");

  if (!hasName && !hasStatus) {
    return res.status(400).json({
      success: false,
      message: "Provide a name or status to update.",
    });
  }

  if (
    hasName &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)
  ) {
    return res.status(400).json({
      success: false,
      message: "Resource name must contain between 1 and 80 characters.",
    });
  }

  if (hasStatus && body.status !== "active" && body.status !== "archived") {
    return res.status(400).json({
      success: false,
      message: "Status must be active or archived.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE database_resources
       SET name = CASE WHEN $3::boolean THEN $4::varchar ELSE name END,
           status = CASE WHEN $5::boolean THEN $6::varchar ELSE status END,
           updated_at = NOW()
       WHERE id = $1 AND project_id = $2
       RETURNING id, project_id, name, engine, schema_name, status, created_at, updated_at`,
      [
        resourceId,
        projectId,
        hasName,
        hasName ? (body.name as string).trim() : null,
        hasStatus,
        hasStatus ? body.status : null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Resource not found." });
    }

    return res.json({
      success: true,
      message: "Database resource updated.",
      resource: result.rows[0],
    });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;