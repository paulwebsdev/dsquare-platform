import path from "node:path";

export type NodeProjectManifest = {
  name?: unknown;
  version?: unknown;
  main?: unknown;
  scripts?: unknown;
  engines?: unknown;
};

export type NodeProjectValidation =
  | { valid: true; entrypoint: string; startCommand: "npm start"; nodeMajor: 22 }
  | { valid: false; error: string };

const SAFE_ENTRYPOINT = /^[A-Za-z0-9_./-]+$/;

export function validateNodeProject(
  packageJson: string,
  uploadedPaths: string[],
): NodeProjectValidation {
  let manifest: NodeProjectManifest;
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, error: "package.json must contain a JSON object." };
    }
    manifest = parsed as NodeProjectManifest;
  } catch {
    return { valid: false, error: "package.json contains invalid JSON." };
  }

  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) ||
      typeof (scripts as Record<string, unknown>).start !== "string" ||
      !(scripts as Record<string, string>).start.trim()) {
    return { valid: false, error: "Add a non-empty scripts.start command to package.json." };
  }

  const engines = manifest.engines;
  if (engines !== undefined) {
    if (!engines || typeof engines !== "object" || Array.isArray(engines)) {
      return { valid: false, error: "package.json engines must be an object." };
    }
    const nodeRange = (engines as Record<string, unknown>).node;
    if (nodeRange !== undefined &&
        (typeof nodeRange !== "string" || !(
          nodeRange === "22" || nodeRange.startsWith("22.") ||
          nodeRange.startsWith("^22") || nodeRange.startsWith("~22") ||
          nodeRange.startsWith(">=22 <23")
        ))) {
      return { valid: false, error: "D Hosting currently supports Node.js 22 projects only." };
    }
  }

  const entrypoint = typeof manifest.main === "string" && manifest.main.trim()
    ? manifest.main.trim()
    : "server.js";

  const entrypointParts = entrypoint.split("/");
  if (
    !SAFE_ENTRYPOINT.test(entrypoint) || entrypoint.startsWith("/") ||
    entrypoint.includes("\\") || entrypointParts.some(part => !part || part === "." || part === "..") ||
    ![".js", ".mjs", ".cjs"].includes(path.posix.extname(entrypoint).toLowerCase()) ||
    path.posix.normalize(entrypoint) !== entrypoint
  ) {
    return { valid: false, error: "The Node.js entrypoint must be a safe relative .js, .mjs, or .cjs path." };
  }

  if (!uploadedPaths.includes("package.json")) {
    return { valid: false, error: "Upload package.json at the website root." };
  }
  if (!uploadedPaths.includes("package-lock.json")) {
    return { valid: false, error: "Upload package-lock.json at the website root so dependencies can be installed reproducibly in an isolated builder." };
  }
  if (!uploadedPaths.includes(entrypoint)) {
    return { valid: false, error: `Upload the configured Node.js entrypoint: ${entrypoint}.` };
  }

  return { valid: true, entrypoint, startCommand: "npm start", nodeMajor: 22 };
}
