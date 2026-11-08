const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_INTERNAL_DOMAIN = "runtime.dsquare.internal";

/**
 * Produces a deterministic internal-only upstream address for a resource.
 * The returned hostname is not a user-provided URL and cannot target localhost,
 * cloud metadata endpoints, or arbitrary internet hosts.
 */
export function getBackendRouteTarget(
  resourceId: string,
  internalDomain = DEFAULT_INTERNAL_DOMAIN,
): string {
  if (!UUID_PATTERN.test(resourceId)) {
    throw new Error("Invalid website resource ID for backend routing.");
  }
  const domain = internalDomain.toLowerCase().trim();
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
    domain === "localhost" ||
    domain.endsWith(".localhost")
  ) {
    throw new Error("Backend runtime domain must be a valid internal DNS domain.");
  }
  return `http://dsquare-site-${resourceId}.${domain}:3000`;
}

export function isAllowedBackendPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !decoded.startsWith("//") && !decoded.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(decoded);
  } catch {
    return false;
  }
}
