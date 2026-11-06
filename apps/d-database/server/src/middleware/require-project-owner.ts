import type { Request, Response, NextFunction } from "express";
import { pool } from "../config/database.js";

export async function requireProjectOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const projectId = String(req.params.projectId || "");
    const userId = res.locals.userId as string;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      res.status(404).json({ success: false, message: "Project not found." });
      return;
    }

    const result = await pool.query(
      "SELECT id FROM projects WHERE id = $1 AND owner_id = $2",
      [projectId, userId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, message: "Project not found." });
      return;
    }

    next();
  } catch (error) {
    console.error("Project ownership check failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to verify project access.",
    });
  }
}