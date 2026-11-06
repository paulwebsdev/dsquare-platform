import { normalizeWebsiteFilePath } from "./website-file-path.js";

export type WebsiteRoot = {
  /** Website-relative directory prefix, including its trailing slash when non-empty. */
  rootPath: string;
  /** Stored path of the homepage file. */
  homepagePath: string;
};

/**
 * Detect the website root from uploaded file paths.
 * A root-level index.html wins. Otherwise, the unique shallowest index.html
 * identifies the uploaded website folder. Equally shallow candidates are
 * treated as ambiguous instead of silently publishing the wrong site.
 */
export function detectWebsiteRoot(filePaths: string[]): WebsiteRoot | null {
  const safePaths = filePaths.filter((filePath) =>
    normalizeWebsiteFilePath(filePath) !== null
  );

  const rootHomepage = safePaths.find(
    (filePath) => filePath.toLowerCase() === "index.html"
  );

  if (rootHomepage) {
    return { rootPath: "", homepagePath: rootHomepage };
  }

  const candidates = safePaths.filter(
    (filePath) => filePath.split("/").at(-1)?.toLowerCase() === "index.html"
  );

  if (candidates.length === 0) return null;

  const directoryDepth = (filePath: string) => filePath.split("/").length - 1;
  const shallowestDepth = Math.min(...candidates.map(directoryDepth));
  const shallowestCandidates = candidates.filter(
    (filePath) => directoryDepth(filePath) === shallowestDepth
  );

  if (shallowestCandidates.length !== 1) return null;

  const homepagePath = shallowestCandidates[0];
  const lastSlash = homepagePath.lastIndexOf("/");

  return {
    rootPath: lastSlash === -1 ? "" : homepagePath.slice(0, lastSlash + 1),
    homepagePath,
  };
}
