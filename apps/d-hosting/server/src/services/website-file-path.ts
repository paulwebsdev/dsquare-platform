import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".txt", ".md", ".xml",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".pdf",
]);

/**
 * Validate a safe website-relative request path.
 * Extensionless paths are allowed so client-side SPA routes can reach index.html.
 */
export function normalizeWebsiteRequestPath(value: string): string | null {
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
  return value;
}

/**
 * Accept a safe website file path with a supported static file extension.
 */
export function normalizeWebsiteFilePath(value: string): string | null {
  const safePath = normalizeWebsiteRequestPath(value);
  if (!safePath) return null;
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(safePath).toLowerCase())) return null;
  return safePath;
}
