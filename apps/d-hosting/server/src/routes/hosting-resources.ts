import { Router, type Response } from "express";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = Router({ mergeParams: true });

router.use(requireAuth);

const validUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function sendError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;

  if (code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A website with this name already exists in this project.",
    });
  }

  console.error(
    "D Hosting resource error:",
    error instanceof Error ? error.message : error
  );

  return res.status(500).json({
    success: false,
    message: "Could not complete the website resource operation.",
  });
}

// List resources belonging to the user's project.
router.get("/", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");

  if (!validUUID(projectId)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  try {
    const includeArchived = req.query.includeArchived === "true";

    const result = await pool.query(
      `SELECT r.id, r.project_id, r.name, r.description, r.site_type,
              r.status, r.created_at, r.updated_at
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.project_id = $1
         AND p.owner_id = $2
         AND ($3::boolean OR r.status <> 'archived')
       ORDER BY r.created_at DESC`,
      [projectId, res.locals.userId, includeArchived]
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

// Create a resource only inside the user's project.
router.post("/", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");

  if (!validUUID(projectId)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  const body = req.body as Record<string, unknown>;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = body?.description === undefined ? "" : body.description;
  const siteType = body?.siteType === undefined ? "static" : body.siteType;

  if (siteType !== "static" && siteType !== "node") {
    return res.status(400).json({ success: false, message: "Website type must be static or node." });
  }

  if (!name || name.length > 80) {
    return res.status(400).json({
      success: false,
      message: "Website name must contain between 1 and 80 characters.",
    });
  }

  if (typeof description !== "string" || description.length > 5000) {
    return res.status(400).json({
      success: false,
      message: "Description must be text and cannot exceed 5,000 characters.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO hosting_resources (project_id, name, description, site_type)
       SELECT p.id, $2, $3, $4
       FROM projects p
       WHERE p.id = $1 AND p.owner_id = $5
       RETURNING id, project_id, name, description, site_type, status, created_at, updated_at`,
      [projectId, name, description.trim(), siteType, res.locals.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Project not found." });
    }

    return res.status(201).json({
      success: true,
      message: siteType === "node" ? "Node.js website resource registered successfully." : "Static website resource registered successfully.",
      resource: result.rows[0],
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Open only a resource in the user's project.
router.get("/:resourceId", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");

  if (!validUUID(projectId) || !validUUID(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid resource or project ID." });
  }

  try {
    const result = await pool.query(
      `SELECT r.id, r.project_id, r.name, r.description, r.site_type,
              r.status, r.created_at, r.updated_at
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3`,
      [resourceId, projectId, res.locals.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    return res.json({ success: true, resource: result.rows[0] });
  } catch (error) {
    return sendError(error, res);
  }
});

// Edit only a resource in the user's project.
router.patch("/:resourceId", async (req, res) => {
  const projectId = String((req.params as Record<string, string>).projectId || "");
  const resourceId = String(req.params.resourceId || "");

  if (!validUUID(projectId) || !validUUID(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid resource or project ID." });
  }

  const body = req.body as Record<string, unknown>;
  const hasName = Object.prototype.hasOwnProperty.call(body || {}, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body || {}, "description");
  const hasStatus = Object.prototype.hasOwnProperty.call(body || {}, "status");

  if (!hasName && !hasDescription && !hasStatus) {
    return res.status(400).json({
      success: false,
      message: "Provide a name, description, or status to update.",
    });
  }

  if (
    hasName &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)
  ) {
    return res.status(400).json({
      success: false,
      message: "Website name must contain between 1 and 80 characters.",
    });
  }

  if (
    hasDescription &&
    (typeof body.description !== "string" || body.description.length > 5000)
  ) {
    return res.status(400).json({
      success: false,
      message: "Description must be text and cannot exceed 5,000 characters.",
    });
  }

  if (hasStatus && body.status === "published") {
    const runtime = await pool.query(
      `SELECT r.site_type, r.active_deployment_id FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3`,
      [resourceId, projectId, res.locals.userId]
    );
    if (runtime.rowCount && runtime.rows[0].site_type === "node") {
      return res.status(409).json({ success: false, message: "Node.js execution is not enabled yet. This website cannot be published until isolated runtime support is available." });
    }
    if (runtime.rowCount !== 1 || !runtime.rows[0].active_deployment_id) {
      return res.status(409).json({ success: false, message: "Create and activate a successful deployment before publishing this website." });
    }
  }

  if (hasStatus && body.status !== "draft" && body.status !== "published" && body.status !== "archived") {
    return res.status(400).json({
      success: false,
      message: "Status must be draft, published, or archived.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE hosting_resources r
       SET name = CASE WHEN $4::boolean THEN $5::varchar ELSE r.name END,
           description = CASE WHEN $6::boolean THEN $7::text ELSE r.description END,
           status = CASE WHEN $8::boolean THEN $9::varchar ELSE r.status END,
           updated_at = NOW()
       FROM projects p
       WHERE r.id = $1
         AND r.project_id = $2
         AND p.id = r.project_id
         AND p.owner_id = $3
       RETURNING r.id, r.project_id, r.name, r.description, r.site_type,
                 r.status, r.created_at, r.updated_at`,
      [
        resourceId,
        projectId,
        res.locals.userId,
        hasName,
        hasName ? (body.name as string).trim() : null,
        hasDescription,
        hasDescription ? (body.description as string).trim() : null,
        hasStatus,
        hasStatus ? body.status : null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    return res.json({
      success: true,
      message: "Website resource updated.",
      resource: result.rows[0],
    });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;

