import { Router, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { normalizeWebsiteRequestPath } from "../services/website-file-path.js";
import { detectWebsiteRoot } from "../services/website-root.js";

const router = Router({ mergeParams: true });

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".xml",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".pdf",
]);

const storageRoot = path.resolve(
  process.env.HOSTING_STORAGE_ROOT ||
    path.join(process.cwd(), "storage", "sites")
);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("/") : value ?? "";
}

export async function serveResourceFile(
  req: Request,
  res: Response,
  projectId: string,
  resourceId: string,
  fileName: string,
  publishedOnly = false
) {

  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid project or resource ID.",
    });
  }

  const safeFileName = normalizeWebsiteRequestPath(fileName);
  if (!safeFileName) {
    return res.status(400).json({
      success: false,
      message: "Invalid website file path.",
    });
  }

  const extension = path.extname(safeFileName).toLowerCase();

  if (extension && !ALLOWED_EXTENSIONS.has(extension)) {
    return res.status(415).json({
      success: false,
      message: "This file type cannot be previewed.",
    });
  }

  try {
    const resourceResult = publishedOnly
      ? await pool.query(
          `SELECT id, status
           FROM hosting_resources
           WHERE id = $1 AND project_id = $2
           LIMIT 1`,
          [resourceId, projectId]
        )
      : await pool.query(
          `SELECT id, status
           FROM hosting_resources
           WHERE id = $1 AND project_id = $2
             AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = hosting_resources.project_id AND p.owner_id = $3
             )
           LIMIT 1`,
          [resourceId, projectId, String(res.locals.userId)]
        );

    if (resourceResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Website resource not found.",
      });
    }

    const resourceStatus = resourceResult.rows[0].status;

    if (resourceStatus === "archived") {
      return res.status(403).json({
        success: false,
        message: "Archived websites cannot be served.",
      });
    }

    if (publishedOnly && resourceStatus !== "published") {
      return res.status(404).json({
        success: false,
        message: "This website is not published.",
      });
    }

    const findStoredFile = async (storedPath: string) =>
      pool.query(
        `SELECT storage_key, mime_type
         FROM hosting_files
         WHERE project_id = $1
           AND resource_id = $2
           AND original_name = $3
         LIMIT 1`,
        [projectId, resourceId, storedPath]
      );

    let fileResult = await findStoredFile(safeFileName);

    if (fileResult.rowCount === 0) {
      const uploadedPaths = await pool.query(
        `SELECT original_name
         FROM hosting_files
         WHERE project_id = $1 AND resource_id = $2`,
        [projectId, resourceId]
      );
      const websiteRoot = detectWebsiteRoot(
        uploadedPaths.rows.map((row: { original_name: string }) => row.original_name)
      );

      if (websiteRoot) {
        const rootedPath = safeFileName === "index.html"
          ? websiteRoot.homepagePath
          : `${websiteRoot.rootPath}${safeFileName}`;

        if (rootedPath !== safeFileName) {
          fileResult = await findStoredFile(rootedPath);
        }

        // Extensionless paths belong to the frontend router when no real file exists.
        if (fileResult.rowCount === 0 && !extension) {
          fileResult = await findStoredFile(websiteRoot.homepagePath);
        }
      }
    }

    if (fileResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Website file not found. Upload an index.html homepage to publish this website.",
      });
    }

    const { storage_key: storageKey, mime_type: mimeType } =
      fileResult.rows[0];

    if (!UUID_PATTERN.test(storageKey)) {
      return res.status(400).json({
        success: false,
        message: "Invalid stored file reference.",
      });
    }

    const filePath = path.join(storageRoot, resourceId, storageKey);

    if (!existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "The stored file is missing.",
      });
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' data: blob: https:; " +
        "script-src 'self' 'unsafe-inline' https:; " +
        "style-src 'self' 'unsafe-inline' https:; " +
        "img-src 'self' data: blob: https:; " +
        "font-src 'self' data: https:; " +
        "media-src 'self' blob: https:; " +
        "connect-src 'self' https:; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'none'; " +
        ""
    );

    res.type(mimeType || extension);
    return res.sendFile(filePath);
  } catch (error) {
    console.error("Website preview error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load website preview.",
    });
  }
}

async function servePreview(
  req: Request,
  res: Response,
  fileName: string,
  publishedOnly = false
) {
  return serveResourceFile(
    req,
    res,
    firstParam(req.params.projectId),
    firstParam(req.params.resourceId),
    fileName,
    publishedOnly
  );
}

router.get("/:resourceId/preview", requireAuth, (req, res) => {
  return servePreview(req, res, "index.html");
});

router.get("/:resourceId/preview/:fileName", requireAuth, (req, res) => {
  return servePreview(req, res, firstParam(req.params.fileName));
});

router.get("/:resourceId/preview/*filePath", requireAuth, (req, res) => {
  return servePreview(req, res, firstParam(req.params.filePath));
});

router.get("/:resourceId/published", (req, res) => {
  return servePreview(req, res, "index.html", true);
});

router.get("/:resourceId/published/:fileName", (req, res) => {
  return servePreview(req, res, firstParam(req.params.fileName), true);
});

router.get("/:resourceId/published/*filePath", (req, res) => {
  return servePreview(req, res, firstParam(req.params.filePath), true);
});

export default router;



