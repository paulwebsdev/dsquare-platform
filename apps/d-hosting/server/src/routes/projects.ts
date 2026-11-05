import { Router, type Response } from "express";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = Router();

router.use(requireAuth);

function validId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function handleError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;

  if (code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A project with this name already exists.",
    });
  }

  console.error("Project API error:", error instanceof Error ? error.message : error);

  return res.status(500).json({
    success: false,
    message: "An unexpected error occurred while managing the project.",
  });
}

// List only the authenticated user's projects.
router.get("/", async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    const userId = res.locals.userId;

    const result = await pool.query(
      `SELECT id, name, description, status, created_at, updated_at
       FROM projects
       WHERE owner_id = $1
         AND ($2::boolean OR status = 'active')
       ORDER BY created_at DESC`,
      [userId, includeArchived]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      projects: result.rows,
    });
  } catch (error) {
    return handleError(error, res);
  }
});

// Create a project owned by the authenticated user.
router.post("/", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    if (!body || typeof body.name !== "string") {
      return res.status(400).json({
        success: false,
        message: "A project name is required.",
      });
    }

    const name = body.name.trim();
    const description = body.description === undefined ? "" : body.description;

    if (!name || name.length > 80) {
      return res.status(400).json({
        success: false,
        message: "Project name must contain between 1 and 80 characters.",
      });
    }

    if (typeof description !== "string" || description.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Description must be text and cannot exceed 5,000 characters.",
      });
    }

    const result = await pool.query(
      `INSERT INTO projects (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, status, created_at, updated_at`,
      [name, description.trim(), res.locals.userId]
    );

    return res.status(201).json({
      success: true,
      message: "Project created successfully.",
      project: result.rows[0],
    });
  } catch (error) {
    return handleError(error, res);
  }
});

// Open only a project belonging to the authenticated user.
router.get("/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, description, status, created_at, updated_at
       FROM projects
       WHERE id = $1 AND owner_id = $2`,
      [req.params.id, res.locals.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Project not found." });
    }

    return res.json({ success: true, project: result.rows[0] });
  } catch (error) {
    return handleError(error, res);
  }
});

// Edit, archive or restore only the user's own project.
router.patch("/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid project ID." });
  }

  try {
    const body = req.body as Record<string, unknown>;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ success: false, message: "Invalid request body." });
    }

    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");

    if (!hasName && !hasDescription && !hasStatus) {
      return res.status(400).json({
        success: false,
        message: "Provide a name, description, or status to update.",
      });
    }

    if (hasName && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
      return res.status(400).json({
        success: false,
        message: "Project name must contain between 1 and 80 characters.",
      });
    }

    if (hasDescription && (typeof body.description !== "string" || body.description.length > 5000)) {
      return res.status(400).json({
        success: false,
        message: "Description must be text and cannot exceed 5,000 characters.",
      });
    }

    if (hasStatus && body.status !== "active" && body.status !== "archived") {
      return res.status(400).json({
        success: false,
        message: "Status must be active or archived.",
      });
    }

    const result = await pool.query(
      `UPDATE projects
       SET name = CASE WHEN $2::boolean THEN $3::varchar ELSE name END,
           description = CASE WHEN $4::boolean THEN $5::text ELSE description END,
           status = CASE WHEN $6::boolean THEN $7::varchar ELSE status END,
           updated_at = NOW()
       WHERE id = $1 AND owner_id = $8
       RETURNING id, name, description, status, created_at, updated_at`,
      [
        req.params.id,
        hasName,
        hasName ? (body.name as string).trim() : null,
        hasDescription,
        hasDescription ? (body.description as string).trim() : null,
        hasStatus,
        hasStatus ? body.status : null,
        res.locals.userId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Project not found." });
    }

    return res.json({
      success: true,
      message: "Project updated successfully.",
      project: result.rows[0],
    });
  } catch (error) {
    return handleError(error, res);
  }
});

export default router;
