import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".md", ".xml",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".pdf",
]);

/**
 * Accept a safe website-relative path while keeping storage files flat and UUID-keyed.
 * Forward slashes are the only path separator; traversal and absolute paths are rejected.
 */
export function normalizeWebsiteFilePath(value: string): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value)
  ) return null;

  const segments = value.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    return null;
  }

  if (path.posix.normalize(value) !== value) return null;
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(value).toLowerCase())) return null;

  return value;
}
