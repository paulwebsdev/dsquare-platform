import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrivateIngressJsonRoute = {
  domain: string;
  resourceId: string;
  deploymentId: string;
};

export function normalizeIngressHostname(value: string): string {
  if (typeof value !== "string" || !value || value.length > 253 ||
      /[/:?#@\\\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Ingress hostname is invalid.");
  }
  const domain = domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase();
  if (!domain || domain.length > 253 || isIP(domain) !== 0 ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(domain) ||
      domain === "localhost" || domain.endsWith(".localhost") ||
      domain.endsWith(".local") || domain.endsWith(".internal") ||
      domain.endsWith(".test") || domain.endsWith(".example") ||
      domain.endsWith(".invalid") || domain.endsWith(".arpa")) {
    throw new Error("Ingress hostname must be a public DNS hostname.");
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) {
    throw new Error("Ingress hostname must be a valid public DNS hostname.");
  }
  return domain;
}

/** JSON accepted by Caddy's admin /load endpoint; no Caddyfile adapter needed. */
export function renderPrivateIngressJsonConfig(
  routes: PrivateIngressJsonRoute[],
  tlsEmail?: string,
): Record<string, unknown> {
  if (!Array.isArray(routes) || routes.length > 2_000) {
    throw new Error("Ingress route list exceeds its permitted size.");
  }
  const normalized = routes.map((route) => {
    if (!route || !UUID.test(route.resourceId) || !UUID.test(route.deploymentId)) {
      throw new Error("Ingress route identity is invalid.");
    }
    return {
      domain: normalizeIngressHostname(route.domain),
      resourceId: route.resourceId.toLowerCase(),
      deploymentId: route.deploymentId.toLowerCase(),
    };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
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

  const subjects = normalized.map((route) => route.domain);
  return {
    admin: { listen: "localhost:2019" },
    apps: {
      http: {
        servers: {
          dsquare: {
            listen: [":80", ":443"],
            routes: normalized.map((route) => ({
              match: [{ host: [route.domain] }],
              handle: [{
                handler: "reverse_proxy",
                upstreams: [{
                  dial: "dsquare-deploy-" + route.deploymentId + ".runtime.dsquare.internal:3000",
                }],
                headers: {
                  request: {
                    set: {
                      Host: ["{http.request.host}"],
                      "X-Forwarded-Host": ["{http.request.host}"],
                      "X-Forwarded-Proto": ["{http.request.scheme}"],
                      "X-Forwarded-For": ["{http.request.remote.host}"],
                    },
                    delete: ["Forwarded", "X-Real-IP"],
                  },
                },
                transport: {
                  protocol: "http",
                  dial_timeout: "3s",
                  response_header_timeout: "30s",
                  read_timeout: "5m",
                  write_timeout: "5m",
                },
              }],
              terminal: true,
            })),
          },
        },
      },
      ...(subjects.length ? {
        tls: {
          automation: {
            policies: [{
              subjects,
              issuers: [{
                module: "acme",
                ...(email ? { email } : {}),
              }],
            }],
          },
        },
      } : {}),
    },
  };
}

export async function applyPrivateIngressConfig(input: {
  adminUrl: string;
  config: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let admin: URL;
  try {
    admin = new URL(input.adminUrl);
  } catch {
    throw new Error("Caddy admin URL is invalid.");
  }
  if (admin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(admin.hostname) ||
      admin.username || admin.password || admin.pathname !== "/" || admin.search || admin.hash) {
    throw new Error("Caddy admin must be an unauthenticated loopback-only HTTP endpoint.");
  }
  const response = await (input.fetchImpl ?? fetch)(new URL("/load", admin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.config),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Caddy rejected the private ingress configuration.");
  }
  await response.body?.cancel().catch(() => undefined);
}
