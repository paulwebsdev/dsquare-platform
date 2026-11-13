import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import { resolveTxt } from "node:dns/promises";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { syncPublishedNodeIngress } from "../services/private-ingress-sync.js";
import { getApiSubdomainConfig } from "../services/api-subdomain-routing.js";

const router = Router({ mergeParams: true });
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const input = value.trim().replace(/\.$/, "");
  if (!input || input.length > 253 || /[/:?#@\\\s]/.test(input)) return null;

  const domain = domainToASCII(input).toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    domain === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(domain)
  ) return null;

  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) =>
      label.length < 1 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) return null;

  return domain;
}

function sendError(error: unknown, res: Response) {
  const code = (error as { code?: string })?.code;
  if (code === "23505") {
    return res.status(409).json({
      success: false,
      message: "This domain is already connected to a D Hosting website.",
    });
  }

  console.error(
    "Custom domain API error:",
    error instanceof Error ? error.message : error
  );
  return res.status(500).json({
    success: false,
    message: "Could not complete the custom domain operation.",
  });
}

function getParams(req: { params: object }) {
  return req.params as Record<string, string>;
}

function withApiDns<T extends { domain: string }>(record: T, siteType: string) {
  if (siteType !== "node") {
    return { ...record, api_enabled: false, api_domain: null, api_dns_record_type: null, api_dns_record_value: null };
  }
  const api = getApiSubdomainConfig(record.domain);
  return {
    ...record,
    api_enabled: true,
    api_domain: api.domain,
    api_dns_record_type: "CNAME",
    api_dns_record_value: api.dnsTarget,
  };
}

function validIds(projectId: string, resourceId: string) {
  return UUID_PATTERN.test(projectId) && UUID_PATTERN.test(resourceId);
}

// List custom domains belonging to a website owned by the signed-in user.
router.get("/:resourceId/domains", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  if (!validIds(projectId, resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const result = await pool.query(
      `SELECT d.id, d.domain, d.status, d.verified_at, d.created_at, r.site_type,
              '_dsquare-verification.' || d.domain AS dns_record_name,
              'TXT' AS dns_record_type,
              'dsquare-domain-verification=' || d.verification_token AS dns_record_value
       FROM hosting_custom_domains d
       INNER JOIN projects p ON p.id = d.project_id
       INNER JOIN hosting_resources r ON r.id = d.resource_id AND r.project_id = d.project_id
       WHERE d.project_id = $1 AND d.resource_id = $2 AND p.owner_id = $3
       ORDER BY d.created_at DESC`,
      [projectId, resourceId, res.locals.userId]
    );

    return res.json({ success: true, count: result.rowCount, domains: result.rows.map((row) => withApiDns(row, String(row.site_type))) });
  } catch (error) {
    return sendError(error, res);
  }
});

// Add a domain and issue a unique DNS TXT ownership challenge.
router.post("/:resourceId/domains", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  if (!validIds(projectId, resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  const domain = normalizeDomain(req.body?.domain);
  if (!domain) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid domain name, such as example.com or www.example.com.",
    });
  }

  try {
    const token = randomBytes(32).toString("hex");
    const result = await pool.query(
      `INSERT INTO hosting_custom_domains
         (project_id, resource_id, domain, verification_token)
       SELECT r.project_id, r.id, $3, $4
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $5
       RETURNING id, domain, status, verified_at, created_at,
                 '_dsquare-verification.' || domain AS dns_record_name,
                 'TXT' AS dns_record_type,
                 'dsquare-domain-verification=' || verification_token AS dns_record_value`,
      [resourceId, projectId, domain, token, res.locals.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    return res.status(201).json({
      success: true,
      message: "Domain added. Publish the DNS TXT record below, then verify ownership.",
      domain: withApiDns(result.rows[0], String((await pool.query("SELECT site_type FROM hosting_resources WHERE id = $1 AND project_id = $2", [resourceId, projectId])).rows[0]?.site_type || "static")),
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Verify ownership by looking up the exact DNS TXT challenge.
router.post("/:resourceId/domains/:domainId/verify", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const domainId = String(req.params.domainId || "");
  if (!validIds(projectId, resourceId) || !UUID_PATTERN.test(domainId)) {
    return res.status(400).json({ success: false, message: "Invalid project, website, or domain ID." });
  }

  try {
    const found = await pool.query(
      `SELECT d.id, d.domain, d.verification_token, d.status, r.site_type
       FROM hosting_custom_domains d
       INNER JOIN projects p ON p.id = d.project_id
       INNER JOIN hosting_resources r ON r.id = d.resource_id AND r.project_id = d.project_id
       WHERE d.id = $1 AND d.project_id = $2
         AND d.resource_id = $3 AND p.owner_id = $4
       LIMIT 1`,
      [domainId, projectId, resourceId, res.locals.userId]
    );

    if (found.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Custom domain not found." });
    }

    const domainRecord = found.rows[0] as {
      id: string;
      domain: string;
      verification_token: string;
      status: string;
      site_type: string;
    };

    if (domainRecord.status === "verified") {
      return res.json({ success: true, message: "Domain ownership is already verified." });
    }

    const recordName = `_dsquare-verification.${domainRecord.domain}`;
    let txtRecords: string[][];

    try {
      txtRecords = await resolveTxt(recordName);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "ETIMEOUT") {
        return res.status(409).json({
          success: false,
          message: "DNS verification record was not found yet. Check the record and try again after DNS updates.",
        });
      }
      throw error;
    }

    const expected = `dsquare-domain-verification=${domainRecord.verification_token}`;
    const verified = txtRecords.some((parts) => parts.join("") === expected);

    if (!verified) {
      return res.status(409).json({
        success: false,
        message: "The DNS TXT record does not match the verification value.",
      });
    }

    await pool.query(
      `UPDATE hosting_custom_domains
       SET status = 'verified', verified_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [domainId]
    );

    try {
      await syncPublishedNodeIngress();
    } catch (error) {
      console.error("Verified domain ingress synchronization failed:", error instanceof Error ? error.message : error);
      return res.status(503).json({
        success: false,
        message: "Domain ownership is verified, but private routing is not ready yet. The domain remains verified and can be synchronized after ingress is configured.",
        domain: withApiDns({ id: domainId, domain: domainRecord.domain, status: "verified" }, domainRecord.site_type),
      });
    }

    return res.json({
      success: true,
      message: "Domain ownership verified. Published Node websites are synchronized to private HTTPS ingress.",
      domain: withApiDns({ id: domainId, domain: domainRecord.domain, status: "verified" }),
    });
  } catch (error) {
    return sendError(error, res);
  }
});

// Remove a domain from this website. Remove the proxy route first so a
// failed ingress update cannot leave a deleted domain serving customer code.
router.delete("/:resourceId/domains/:domainId", async (req, res) => {
  const params = getParams(req);
  const projectId = params.projectId || "";
  const resourceId = params.resourceId || "";
  const domainId = String(req.params.domainId || "");
  if (!validIds(projectId, resourceId) || !UUID_PATTERN.test(domainId)) {
    return res.status(400).json({ success: false, message: "Invalid project, website, or domain ID." });
  }

  try {
    const existing = await pool.query(
      `SELECT d.id, r.site_type, r.status AS resource_status
       FROM hosting_custom_domains d
       INNER JOIN hosting_resources r ON r.id = d.resource_id AND r.project_id = d.project_id
       INNER JOIN projects p ON p.id = d.project_id
       WHERE d.id = $1 AND d.project_id = $2 AND d.resource_id = $3
         AND p.owner_id = $4 LIMIT 1`,
      [domainId, projectId, resourceId, res.locals.userId],
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Custom domain not found." });
    }

    try {
      if (existing.rows[0].site_type === "node" && existing.rows[0].resource_status === "published") {
        await syncPublishedNodeIngress(domainId);
      }
    } catch (error) {
      console.error("Domain ingress removal failed:", error instanceof Error ? error.message : error);
      return res.status(503).json({
        success: false,
        message: "The domain was not removed because its private ingress route could not be safely disabled. Try again when the runtime agent is available.",
      });
    }

    const result = await pool.query(
      `DELETE FROM hosting_custom_domains d
       USING projects p
       WHERE d.id = $1 AND d.project_id = $2 AND d.resource_id = $3
         AND p.id = d.project_id AND p.owner_id = $4
       RETURNING d.id`,
      [domainId, projectId, resourceId, res.locals.userId],
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ success: false, message: "Custom domain changed while it was being removed. Its ingress route has been disabled." });
    }
    return res.json({ success: true, message: "Custom domain removed and private ingress synchronized." });
  } catch (error) {
    return sendError(error, res);
  }
});

export default router;
