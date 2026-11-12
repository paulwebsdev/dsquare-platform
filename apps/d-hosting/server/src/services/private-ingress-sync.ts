import { pool } from "../config/database.js";
import {
  syncRuntimeAgentIngress,
  type RuntimeAgentIngressRoute,
} from "./runtime-agent-client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agentOptions() {
  const baseUrl = process.env.D_HOSTING_RUNTIME_AGENT_URL?.trim();
  const secret = process.env.D_HOSTING_RUNTIME_AGENT_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret, timeoutMs: 15_000 };
}

/**
 * Rebuilds the complete Node custom-domain table from authoritative Hosting DB
 * state. Static websites remain served by the existing Hosting web process.
 */
export async function syncPublishedNodeIngress(excludeDomainId?: string): Promise<{ routeCount: number; applied: boolean }> {
  if (excludeDomainId !== undefined && !UUID.test(excludeDomainId)) {
    throw new Error("Ingress exclusion domain ID is invalid.");
  }
  const result = await pool.query<{
    domain: string;
    resource_id: string;
    active_deployment_id: string;
  }>(
    `SELECT d.domain, d.resource_id, r.active_deployment_id
     FROM hosting_custom_domains d
     INNER JOIN hosting_resources r
       ON r.id = d.resource_id AND r.project_id = d.project_id
     WHERE d.status = 'verified'
       AND r.status = 'published'
       AND r.site_type = 'node'
       AND r.active_deployment_id IS NOT NULL
       AND ($1::uuid IS NULL OR d.id <> $1::uuid)
     ORDER BY d.domain ASC`,
    [excludeDomainId ?? null],
  );
  const routes: RuntimeAgentIngressRoute[] = result.rows.map((row) => ({
    domain: row.domain,
    resourceId: row.resource_id,
    deploymentId: row.active_deployment_id,
  }));
  if (routes.some((route) => !UUID.test(route.resourceId) || !UUID.test(route.deploymentId))) {
    throw new Error("Published Node ingress contains an invalid deployment identity.");
  }
  const agent = agentOptions();
  if (!agent) {
    if (routes.length) throw new Error("Private runtime agent is not configured for Node custom domains.");
    return { routeCount: 0, applied: false };
  }
  await syncRuntimeAgentIngress(agent, routes, process.env.D_HOSTING_TLS_EMAIL?.trim() || undefined);
  return { routeCount: routes.length, applied: true };
}
