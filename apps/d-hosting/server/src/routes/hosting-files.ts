import { Router, type Response } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { normalizeWebsiteFilePath } from "../services/website-file-path.js";
import { checkWebsiteFileQuota } from "../services/website-file-quota.js";
import { websiteObjectStorage } from "../services/website-object-storage.js";

const router = Router({ mergeParams: true });

router.use(requireAuth);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const FILE_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

function getParams(req: { params: object }) {
  return req.params as Record<string, string>;
}

function validFileName(name: string) {
  return normalizeWebsiteFilePath(name) !== null &&
    Object.prototype.hasOwnProperty.call(
      FILE_TYPES,
      path.extname(name).toLowerCase()
    );
}

function getFilePath(resourceId: string, storageKey: string) {
  if (!UUID_PATTERN.test(resourceId) || !UUID_PATTERN.test(storageKey)) {
    throw new Error("Invalid storage identifier.");
  }

  return path.join(storageRoot, resourceId, storageKey);
}

function sendError(error: unknown, res: Response) {
  console.error(
    "D Hosting file error:",
    error instanceof Error ? error.message : error
  );

  return res.status(500).json({
    success: false,
    message: "Could not complete the file operation.",
  });
}

async function getWebsite(projectId: string, resourceId: string, userId: string) {
  return pool.query(
    `SELECT r.id, r.project_id, r.status, r.file_storage_quota_bytes, p.owner_id
     FROM hosting_resources r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
     LIMIT 1`,
    [resourceId, projectId, userId]
  );
}

// List uploaded files for one website resource.
router.get("/:resourceId/files", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";

  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or resource ID." });
  }

  try {
    const website = await getWebsite(projectId, resourceId, String(res.locals.userId || ""));

    if (website.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT id, resource_id, original_name, mime_type, size_bytes, created_at
       FROM hosting_files
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY created_at DESC`,
      [projectId, resourceId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      files: result.rows,
      storage: {
        usedBytes: result.rows.reduce((total, file) => total + Number(file.size_bytes || 0), 0),
        quotaBytes: Number(website.rows[0].file_storage_quota_bytes),
      },
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Upload one file as a raw binary request body.
router.post(
  "/:resourceId/files",
  express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }),
  async (req, res) => {
    const params = getParams(req);
    const projectId = params.projectId || "";
    const resourceId = params.resourceId || "";

    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
      return res.status(400).json({ success: false, message: "Invalid project or resource ID." });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Upload a non-empty file using application/octet-stream.",
      });
    }

    if (req.body.length > MAX_FILE_BYTES) {
      return res.status(413).json({ success: false, message: "Maximum file size is 10 MB." });
    }

    const encodedName = req.header("x-file-name");

    if (!encodedName) {
      return res.status(400).json({ success: false, message: "X-File-Name header is required." });
    }

    let originalName: string;

    try {
      originalName = decodeURIComponent(encodedName);
    } catch {
      return res.status(400).json({ success: false, message: "Invalid encoded file name." });
    }

    if (!validFileName(originalName)) {
      return res.status(400).json({
        success: false,
        message: "This file type is not supported for website uploads.",
      });
    }

    try {
      const website = await getWebsite(projectId, resourceId, String(res.locals.userId || ""));

      if (website.rowCount === 0) {
        return res.status(404).json({ success: false, message: "Website resource not found." });
      }

      if (website.rows[0].status === "archived") {
        return res.status(409).json({
          success: false,
          message: "Restore this website resource before uploading files.",
        });
      }

      const fileId = randomUUID();
      const storageKey = randomUUID();
      const mimeType = FILE_TYPES[path.extname(originalName).toLowerCase()];
      const client = await pool.connect();
      let storedKey: string | null = null;

      try {
        await client.query("BEGIN");
        await checkWebsiteFileQuota({
          queryable: client,
          projectId,
          resourceId,
          uploadBytes: req.body.length,
        });
        storedKey = await websiteObjectStorage.put({
          ownerId: String(website.rows[0].owner_id), projectId, resourceId, objectId: storageKey,
        }, req.body, mimeType);

        const result = await client.query(
          `INSERT INTO hosting_files
             (id, project_id, resource_id, original_name, storage_key, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, resource_id, original_name, mime_type, size_bytes, created_at`,
          [fileId, projectId, resourceId, originalName, storedKey, mimeType, req.body.length],
        );
        await client.query("COMMIT");

        return res.status(201).json({
          success: true,
          message: "File uploaded to private website storage.",
          file: result.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (storedKey) await websiteObjectStorage.delete(storedKey, resourceId).catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;

      if (code === "HOSTING_WEBSITE_ARCHIVED") {
        return res.status(409).json({ success: false, message: error instanceof Error ? error.message : "Website is archived." });
      }

      if (code === "HOSTING_STORAGE_QUOTA_EXCEEDED") {
        return res.status(413).json({ success: false, message: error instanceof Error ? error.message : "Website storage quota exceeded." });
      }

      if (code === "23503") {
        return res.status(404).json({ success: false, message: "Website resource not found." });
      }

      return sendError(error, res);
    }
  }
);

// Download a file as an attachment, never execute or render it here.
router.get("/:resourceId/files/:fileId/download", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const fileId = params.fileId || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !UUID_PATTERN.test(fileId)
  ) {
    return res.status(400).json({ success: false, message: "Invalid file or resource ID." });
  }

  try {
    const website = await getWebsite(projectId, resourceId, String(res.locals.userId || ""));
    if (website.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT original_name, storage_key
       FROM hosting_files
       WHERE id = $1 AND project_id = $2 AND resource_id = $3`,
      [fileId, projectId, resourceId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    const file = result.rows[0] as {
      original_name: string;
      storage_key: string;
    };

    const filePath = getFilePath(resourceId, file.storage_key);
    const contents = await websiteObjectStorage.get(file.storage_key, resourceId);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`
    );

    return res.send(contents);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT" || (error as { name?: string })?.name === "NoSuchKey") {
      return res.status(404).json({ success: false, message: "Stored file is missing." });
    }

    return sendError(error, res);
  }
});

// Rename a stored file without changing its actual bytes or file type.
router.patch("/:resourceId/files/:fileId", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const fileId = params.fileId || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !UUID_PATTERN.test(fileId)
  ) {
    return res.status(400).json({ success: false, message: "Invalid file or resource ID." });
  }

  const newName =
    typeof req.body?.name === "string" ? req.body.name.trim() : "";

  if (!validFileName(newName)) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid website-relative path with a supported file extension.",
    });
  }

  try {
    const website = await getWebsite(projectId, resourceId, String(res.locals.userId || ""));
    if (website.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const existing = await pool.query(
      `SELECT original_name
       FROM hosting_files
       WHERE id = $1 AND project_id = $2 AND resource_id = $3`,
      [fileId, projectId, resourceId]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    if (
      path.extname(newName).toLowerCase() !==
      path.extname(existing.rows[0].original_name).toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        message: "Renaming a file must keep its original file extension.",
      });
    }

    const result = await pool.query(
      `UPDATE hosting_files
       SET original_name = $1
       WHERE id = $2 AND project_id = $3 AND resource_id = $4
       RETURNING id, resource_id, original_name, mime_type, size_bytes, created_at`,
      [newName, fileId, projectId, resourceId]
    );

    return res.json({
      success: true,
      message: "File renamed.",
      file: result.rows[0],
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Delete a file and its metadata.
router.delete("/:resourceId/files/:fileId", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const fileId = params.fileId || "";

  if (
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(resourceId) ||
    !UUID_PATTERN.test(fileId)
  ) {
    return res.status(400).json({ success: false, message: "Invalid file or resource ID." });
  }

  try {
    const website = await getWebsite(projectId, resourceId, String(res.locals.userId || ""));
    if (website.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT storage_key
       FROM hosting_files
       WHERE id = $1 AND project_id = $2 AND resource_id = $3`,
      [fileId, projectId, resourceId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    await websiteObjectStorage.delete(String(result.rows[0].storage_key), resourceId);

    await pool.query(
      `DELETE FROM hosting_files
       WHERE id = $1 AND project_id = $2 AND resource_id = $3`,
      [fileId, projectId, resourceId]
    );

    return res.json({ success: true, message: "File deleted." });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;

