import { domainToASCII } from "node:url";
import { pool } from "../config/database.js";

export interface PublishedDomainTarget {
  projectId: string;
  resourceId: string;
  domain: string;
}

/**
 * Resolve a request hostname to a published website.
 * The caller must pass the canonical hostname selected by the HTTP server/proxy.
 */
export async function resolvePublishedDomain(
  requestHostname: string
): Promise<PublishedDomainTarget | null> {
  const hostname = domainToASCII(
    requestHostname.trim().replace(/:\d+$/, "").replace(/\.$/, "")
  ).toLowerCase();

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.split(".").length < 2
  ) {
    return null;
  }

  const result = await pool.query<{
    project_id: string;
    resource_id: string;
    domain: string;
  }>(
    \`SELECT d.project_id, d.resource_id, d.domain
     FROM hosting_custom_domains d
     INNER JOIN hosting_resources r
       ON r.id = d.resource_id AND r.project_id = d.project_id
     WHERE d.domain = $1
       AND d.status = 'verified'
       AND r.status = 'published'
     LIMIT 1\`,
    [hostname]
  );

  if (result.rowCount === 0) return null;

  return {
    projectId: result.rows[0].project_id,
    resourceId: result.rows[0].resource_id,
    domain: result.rows[0].domain,
  };
}
