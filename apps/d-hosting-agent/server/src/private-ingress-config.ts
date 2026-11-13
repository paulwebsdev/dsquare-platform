import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_SUFFIX = ".runtime.dsquare.internal";

export type PrivateIngressRoute = {
  domain: string;
  resourceId: string;
};

export function normalizePrivateIngressDomain(value: string): string {
  if (typeof value !== "string" || !value || value.length > 253 ||
      /[/:?#@\\\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Ingress domain is invalid.");
  }
  const domain = domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase();
  if (!domain || domain.length > 253 || isIP(domain) !== 0 ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(domain) ||
      domain === "localhost" || domain.endsWith(".localhost") ||
      domain.endsWith(".local") || domain.endsWith(".internal") ||
      domain.endsWith(".test") || domain.endsWith(".example") ||
      domain.endsWith(".invalid") || domain.endsWith(".arpa") ||
      domain.endsWith(INTERNAL_SUFFIX.slice(1))) {
    throw new Error("Ingress domain must be a public DNS hostname.");
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) {
    throw new Error("Ingress domain must be a valid public DNS hostname.");
  }
  return domain;
}

/**
 * Renders deterministic Caddy routing for verified, published Node domains.
 * Caddy owns public TLS; upstreams are private aliases on the Podman network.
 */
export function renderPrivateIngressConfig(
  routes: PrivateIngressRoute[],
  tlsEmail?: string,
): string {
  if (!Array.isArray(routes) || routes.length > 2_000) {
    throw new Error("Ingress route list exceeds its permitted size.");
  }
  const normalized = routes.map((route) => {
    if (!route || !UUID.test(route.resourceId)) throw new Error("Ingress route resource ID is invalid.");
    return {
      domain: normalizePrivateIngressDomain(route.domain),
      resourceId: route.resourceId.toLowerCase(),
    };
  }).sort((left, right) => left.domain.localeCompare(right.domain));

  const seen = new Set<string>();
  for (const route of normalized) {
    if (seen.has(route.domain)) throw new Error("Ingress domain is assigned more than once.");
    seen.add(route.domain);
  }

  const email = tlsEmail?.trim();
  if (email && (email.length > 254 || /[\r\n{}]/.test(email) ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new Error("TLS contact email is invalid.");
  }

  const lines = [
    "{",
    "  admin localhost:2019",
    ...(email ? ["  email " + email] : []),
    "}",
    "",
  ];
  for (const route of normalized) {
    lines.push(
      route.domain + " {",
      "  encode gzip zstd",
      "  reverse_proxy dsquare-site-" + route.resourceId + INTERNAL_SUFFIX + ":3000 {",
      "    header_up Host {host}",
      "    header_up X-Forwarded-Host {host}",
      "    header_up X-Forwarded-Proto {scheme}",
      "    header_up X-Forwarded-For {remote_host}",
      "    header_up -Forwarded",
      "    header_up -X-Real-IP",
      "    transport http {",
      "      dial_timeout 3s",
      "      response_header_timeout 30s",
      "      read_timeout 5m",
      "      write_timeout 5m",
      "    }",
      "  }",
      "}",
      "",
    );
  }
  return lines.join("\n");
}
