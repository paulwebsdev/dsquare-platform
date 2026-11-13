export type ApiSubdomainConfig = { domain: string; dnsTarget: string };

/**
 * Derives a stable API hostname for a verified website domain.
 * www.example.com maps to api.example.com; other hosts map to api.<host>.
 * The DNS target is the website hostname, so its existing A/AAAA records can
 * be reused through a CNAME without exposing the runtime container directly.
 */
export function getApiSubdomainConfig(websiteDomain: string): ApiSubdomainConfig {
  if (typeof websiteDomain !== "string" || !websiteDomain || websiteDomain.length > 253 ||
      /[/:?#@\\\s\u0000-\u001f\u007f]/.test(websiteDomain)) {
    throw new Error("Website domain is invalid for API subdomain routing.");
  }
  const normalized = websiteDomain.toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) {
    throw new Error("Website domain is invalid for API subdomain routing.");
  }
  const dnsTarget = normalized;
  const apiHostBase = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
  const domain = "api." + apiHostBase;
  if (domain.length > 253) throw new Error("Derived API subdomain exceeds DNS hostname limits.");
  return { domain, dnsTarget };
}

/**
 * Adds API hostnames while refusing collisions with registered custom domains.
 * Apex and www aliases may intentionally share one API hostname when they
 * resolve to the same website resource and immutable deployment.
 */
export function expandIngressRoutes<T extends { domain: string; resourceId: string; deploymentId: string }>(
  routes: T[],
  reservedDomains: string[] = [],
): Array<T> {
  const expanded: T[] = [];
  const seen = new Map<string, { resourceId: string; deploymentId: string }>();
  const reserved = new Set(reservedDomains.map((domain) => domain.toLowerCase()));
  for (const route of routes) {
    const base = route.domain.toLowerCase();
    const api = getApiSubdomainConfig(base).domain;
    if (reserved.has(api) && api !== base) {
      throw new Error("Private ingress API hostname is already reserved by a custom domain.");
    }
    for (const domain of [base, api]) {
      const previous = seen.get(domain);
      if (previous) {
        if (previous.resourceId === route.resourceId && previous.deploymentId === route.deploymentId) continue;
        throw new Error("Private ingress hostname is assigned more than once.");
      }
      seen.set(domain, { resourceId: route.resourceId, deploymentId: route.deploymentId });
      expanded.push({ ...route, domain });
    }
  }
  return expanded.sort((a, b) => a.domain.localeCompare(b.domain));
}
