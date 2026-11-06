import path from "node:path";
import { normalizeWebsiteRequestPath } from "./website-file-path.js";
import { detectWebsiteRoot } from "./website-root.js";

/**
 * Return stored-path candidates in priority order for preview and published
 * domain requests. The first candidate is the exact requested path; uploaded
 * folder roots and SPA fallback are considered only when that file is absent.
 */
export function getWebsiteFileCandidates(
  requestPath: string,
  uploadedPaths: string[]
): string[] {
  const safePath = normalizeWebsiteRequestPath(requestPath);
  if (!safePath) return [];

  const candidates = [safePath];
  const websiteRoot = detectWebsiteRoot(uploadedPaths);
  if (!websiteRoot) return candidates;

  const rootedPath = safePath === "index.html"
    ? websiteRoot.homepagePath
    : `${websiteRoot.rootPath}${safePath}`;

  if (!candidates.includes(rootedPath)) candidates.push(rootedPath);

  // Missing extensionless paths are client-side SPA routes.
  if (!path.posix.extname(safePath) &&
      !candidates.includes(websiteRoot.homepagePath)) {
    candidates.push(websiteRoot.homepagePath);
  }

  return candidates;
}
