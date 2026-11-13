const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_INTERNAL_DOMAIN = "runtime.dsquare.internal";

/**
 * Produces the private upstream address for one immutable deployment.
 * The hostname format intentionally matches the alias assigned by the
 * Runtime Agent and consumed by Caddy during deployment-specific cutover.
 */
export function getBackendRouteTarget(
  resourceId: string,
  deploymentId: string,
  internalDomain = DEFAULT_INTERNAL_DOMAIN,
): string {
  if (!UUID_PATTERN.test(resourceId)) {
    throw new Error("Invalid website resource ID for backend routing.");
  }
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new Error("Invalid deployment ID for backend routing.");
  }
  const domain = internalDomain.toLowerCase().trim();
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$/.test(domain) ||
    domain === "localhost" ||
    domain.endsWith(".localhost")
  ) {
    throw new Error("Backend runtime domain must be a valid internal DNS domain.");
  }
  return `http://dsquare-deploy-${deploymentId.toLowerCase()}.${domain}:3000`;
}

export function isAllowedBackendPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\\\") ||
      /[\\u0000-\\u001f\\u007f]/.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    const pathname = decoded.split(/[?#]/, 1)[0];
    const segments = pathname.split("/");
    return !decoded.startsWith("//") && !decoded.includes("\\\\") &&
      !/[\\u0000-\\u001f\\u007f]/.test(decoded) &&
      !segments.some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}
