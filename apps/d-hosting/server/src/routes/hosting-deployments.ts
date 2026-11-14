import { Router } from "express";
import { mkdir, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { getWebsiteFileCandidates } from "../services/website-file-resolution.js";
import { validateNodeProject } from "../services/node-project-validation.js";
import { startBuiltRemoteNodeRuntime } from "../services/remote-node-runtime.js";
import { websiteObjectStorage } from "../services/website-object-storage.js";
import { syncPublishedNodeIngress } from "../services/private-ingress-sync.js";
import {
  checkRuntimeAgentHealth,
  getRuntimeAgentRuntime,
  getRuntimeAgentLogs,
  changeRuntimeAgentRuntimeState,
  deleteRuntimeAgentArtifact,
  deleteRuntimeAgentRuntime,
} from "../services/runtime-agent-client.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageRoot = path.resolve(process.env.HOSTING_STORAGE_ROOT || path.join(process.cwd(), "storage", "sites"));

type ManifestFile = {
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string | number;
};

function params(req: { params: object }) {
  return req.params as Record<string, string>;
}

async function ownedResource(projectId: string, resourceId: string, userId: string) {
  return pool.query(
    `SELECT r.id, r.project_id, r.status, r.site_type, r.active_deployment_id, p.owner_id
     FROM hosting_resources r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
     LIMIT 1`,
    [resourceId, projectId, userId]
  );
}



// Report private runtime-agent connectivity and execution capability for an owned website.
// This diagnostic never starts a runtime or executes customer code.
router.get("/:resourceId/runtime-status", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const resource = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (resource.rowCount !== 1) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const baseUrl = process.env.D_HOSTING_RUNTIME_AGENT_URL?.trim();
    const secret = process.env.D_HOSTING_RUNTIME_AGENT_SECRET;
    if (!baseUrl || !secret) {
      return res.json({
        success: true,
        runtime: {
          configured: false,
          agentReachable: false,
          providerConfigured: false,
          executionEnabled: false,
          runtimeAvailable: false,
          message: "The private runtime agent is not configured. Customer backend code remains disabled.",
        },
      });
    }

    try {
      const health = await checkRuntimeAgentHealth({ baseUrl, secret });
      const runtimeAvailable = health.providerConfigured && health.executionEnabled;
      return res.json({
        success: true,
        runtime: {
          configured: true,
          agentReachable: true,
          providerConfigured: health.providerConfigured,
          executionEnabled: health.executionEnabled,
          runtimeAvailable,
          message: runtimeAvailable
            ? "The isolated runtime provider is ready."
            : "The agent is reachable, but isolated execution is not enabled.",
        },
      });
    } catch {
      return res.status(503).json({
        success: false,
        runtime: {
          configured: true,
          agentReachable: false,
          providerConfigured: false,
          executionEnabled: false,
          runtimeAvailable: false,
          message: "The private runtime agent is unreachable or failed its health check.",
        },
      });
    }
  } catch (error) {
    console.error("Runtime status check error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not check runtime status." });
  }
});


function runtimeAgentOptions() {
  const baseUrl = process.env.D_HOSTING_RUNTIME_AGENT_URL?.trim();
  const secret = process.env.D_HOSTING_RUNTIME_AGENT_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

/** Retain the live deployment and two rollback candidates; retire older containers only after ingress cutover. */
async function cleanupRetiredNodeRuntimes(resourceId: string, agent: NonNullable<ReturnType<typeof runtimeAgentOptions>>): Promise<void> {
  const stale = await pool.query<{ id: string }>(
    `SELECT id
     FROM hosting_deployments
     WHERE resource_id = $1 AND status = 'succeeded'
     ORDER BY deployment_number DESC
     OFFSET 3`,
    [resourceId],
  );
  for (const row of stale.rows) {
    if (!UUID_PATTERN.test(row.id)) continue;
    try {
      const removed = await deleteRuntimeAgentRuntime(agent, resourceId, row.id);
      if (removed.deleted) await deleteRuntimeAgentArtifact(agent, row.id);
    } catch (error) {
      // Cleanup is best-effort. A retained artifact is safer than deleting one
      // while its runtime may still be serving traffic.
      console.error("Retired Node runtime cleanup failed:", error instanceof Error ? error.message : error);
    }
  }
}

// Read the actual isolated runtime state for an owned Node.js website.
router.get("/:resourceId/runtime", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }
  try {
    const owned = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount !== 1) return res.status(404).json({ success: false, message: "Website resource not found." });
    const deploymentId = String(owned.rows[0].active_deployment_id || "");
    if (!UUID_PATTERN.test(deploymentId)) return res.status(404).json({ success: false, message: "No active Node.js deployment was found." });
    if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime controls are only available for Node.js websites." });
    const agent = runtimeAgentOptions();
    if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });

    const runtime = await getRuntimeAgentRuntime(agent, resourceId, deploymentId);
    await pool.query(
      `INSERT INTO hosting_runtime_instances
         (resource_id, provider, status, deployment_id, started_at, stopped_at, updated_at)
       VALUES ($1, 'podman', $2, $3,
               CASE WHEN $2 = 'running' THEN NOW() ELSE NULL END,
               CASE WHEN $2 = 'stopped' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (resource_id) DO UPDATE
       SET provider = 'podman',
           status = EXCLUDED.status,
           deployment_id = COALESCE(EXCLUDED.deployment_id, hosting_runtime_instances.deployment_id),
           started_at = CASE
             WHEN EXCLUDED.status = 'running' AND hosting_runtime_instances.status <> 'running' THEN NOW()
             ELSE hosting_runtime_instances.started_at
           END,
           stopped_at = CASE
             WHEN EXCLUDED.status = 'stopped' AND hosting_runtime_instances.status <> 'stopped' THEN NOW()
             ELSE hosting_runtime_instances.stopped_at
           END,
           updated_at = NOW()`,
      [resourceId, runtime.state, runtime.deploymentId],
    );
    return res.json({ success: true, runtime });
  } catch (error) {
    console.error("Runtime inspection failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Runtime status is unavailable." });
  }
});

// Runtime logs are owner-scoped and returned only after the private agent authenticates the request.
router.get("/:resourceId/runtime/logs", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }
  try {
    const owned = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount !== 1) return res.status(404).json({ success: false, message: "Website resource not found." });
    const deploymentId = String(owned.rows[0].active_deployment_id || "");
    if (!UUID_PATTERN.test(deploymentId)) return res.status(404).json({ success: false, message: "No active Node.js deployment was found." });
    if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime logs are only available for Node.js websites." });
    const agent = runtimeAgentOptions();
    if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });
    const result = await getRuntimeAgentLogs(agent, resourceId, deploymentId);
    return res.json({ success: true, resourceId, logs: result.logs });
  } catch (error) {
    console.error("Runtime log retrieval failed:", error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: "Runtime logs are unavailable." });
  }
});

for (const action of ["stop", "restart"] as const) {
  router.post(`/:resourceId/runtime/${action}`, async (req, res) => {
    const { projectId = "", resourceId = "" } = params(req);
    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
      return res.status(400).json({ success: false, message: "Invalid project or website ID." });
    }
    try {
      const owned = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
      if (owned.rowCount !== 1) return res.status(404).json({ success: false, message: "Website resource not found." });
      const deploymentId = String(owned.rows[0].active_deployment_id || "");
      if (!UUID_PATTERN.test(deploymentId)) return res.status(404).json({ success: false, message: "No active Node.js deployment was found." });
      if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime controls are only available for Node.js websites." });
      if (owned.rows[0].status === "archived") return res.status(409).json({ success: false, message: "Restore this website before changing its runtime." });
      const agent = runtimeAgentOptions();
      if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });
      const runtime = await changeRuntimeAgentRuntimeState(agent, resourceId, deploymentId, action);
      await pool.query(
        `INSERT INTO hosting_runtime_instances
           (resource_id, provider, status, deployment_id, started_at, stopped_at, updated_at)
         VALUES ($1, 'podman', $2, $3,
                 CASE WHEN $2 = 'running' THEN NOW() ELSE NULL END,
                 CASE WHEN $2 = 'stopped' THEN NOW() ELSE NULL END, NOW())
         ON CONFLICT (resource_id) DO UPDATE
         SET provider = 'podman',
             status = EXCLUDED.status,
             deployment_id = COALESCE(EXCLUDED.deployment_id, hosting_runtime_instances.deployment_id),
             started_at = CASE
               WHEN EXCLUDED.status = 'running' AND hosting_runtime_instances.status <> 'running' THEN NOW()
               ELSE hosting_runtime_instances.started_at
             END,
             stopped_at = CASE
               WHEN EXCLUDED.status = 'stopped' AND hosting_runtime_instances.status <> 'stopped' THEN NOW()
               ELSE hosting_runtime_instances.stopped_at
             END,
             updated_at = NOW()`,
        [resourceId, runtime.state, owned.rows[0].active_deployment_id],
      );
      return res.json({ success: true, runtime, message: action === "stop" ? "Website runtime stopped." : "Website runtime restarted." });
    } catch (error) {
      console.error(`Runtime ${action} failed:`, error instanceof Error ? error.message : error);
      return res.status(503).json({ success: false, message: `Runtime ${action} is unavailable.` });
    }
  });
}

// Return deployment attempts newest first, including the currently active version.
router.get("/:resourceId/deployments", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const resource = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (resource.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }

    const result = await pool.query(
      `SELECT id, project_id, resource_id, deployment_number, status,
              file_manifest, error_summary, started_at, finished_at, created_at,
              (id = $3::uuid) AS is_active
       FROM hosting_deployments
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY deployment_number DESC
       LIMIT 20`,
      [projectId, resourceId, resource.rows[0].active_deployment_id]
    );

    return res.json({ success: true, deployments: result.rows });
  } catch (error) {
    console.error("Deployment history error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not load deployment history." });
  }
});

// Activate a successful immutable version. This also provides the safe rollback operation.
router.post("/:resourceId/deployments/:deploymentId/activate", async (req, res) => {
  const { projectId = "", resourceId = "", deploymentId = "" } = params(req);
  if (![projectId, resourceId, deploymentId].every(value => UUID_PATTERN.test(value))) {
    return res.status(400).json({ success: false, message: "Invalid project, website, or deployment ID." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resource = await client.query(
      `SELECT r.id, r.status, r.site_type, r.active_deployment_id, p.owner_id
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, String(res.locals.userId || "")]
    );
    if (resource.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }
    if (resource.rows[0].status === "archived") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Restore this website before activating a deployment." });
    }
    const deployment = await client.query(
      `SELECT id FROM hosting_deployments
       WHERE id = $1 AND project_id = $2 AND resource_id = $3 AND status = 'succeeded'
       LIMIT 1`,
      [deploymentId, projectId, resourceId]
    );
    if (deployment.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Only a successful deployment belonging to this website can be activated." });
    }

    if (resource.rows[0].site_type === "node") {
      const agent = runtimeAgentOptions();
      if (!agent) {
        await client.query("ROLLBACK");
        return res.status(503).json({ success: false, message: "The private runtime agent is not configured; the live deployment was left unchanged." });
      }
      try {
        const targetRuntime = await getRuntimeAgentRuntime(agent, resourceId, deploymentId);
        if (targetRuntime.state !== "running") {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "This Node.js deployment is not running; the live deployment was left unchanged." });
        }
      } catch {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "This Node.js deployment is unavailable; the live deployment was left unchanged." });
      }
    }

    const updated = await client.query(
      `UPDATE hosting_resources
       SET active_deployment_id = $3, status = 'published', updated_at = NOW()
       WHERE id = $1 AND project_id = $2
       RETURNING id, status, active_deployment_id`,
      [resourceId, projectId, deploymentId]
    );
    if (resource.rows[0].site_type === "node") {
      await client.query(
        `INSERT INTO hosting_runtime_instances
           (resource_id, provider, status, deployment_id, started_at, stopped_at, updated_at)
         VALUES ($1, 'podman', 'running', $2, NOW(), NULL, NOW())
         ON CONFLICT (resource_id) DO UPDATE
         SET provider = 'podman', status = 'running', deployment_id = EXCLUDED.deployment_id,
             started_at = NOW(), stopped_at = NULL, updated_at = NOW()`,
        [resourceId, deploymentId],
      );
    }
    await client.query("COMMIT");

    if (resource.rows[0].site_type === "node") {
      try {
        await syncPublishedNodeIngress();
      } catch (ingressError) {
        console.error("Deployment activation ingress sync failed:", ingressError instanceof Error ? ingressError.message : ingressError);
        // Keep the database's active pointer consistent with the last known
        // working route. Runtime containers are retained; no live version is
        // deleted during a failed cutover.
        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE hosting_resources
             SET active_deployment_id = $3, status = $4, updated_at = NOW()
             WHERE id = $1 AND project_id = $2 AND active_deployment_id = $5`,
            [resourceId, projectId, resource.rows[0].active_deployment_id, resource.rows[0].status, deploymentId],
          );
          if (resource.rows[0].active_deployment_id && UUID_PATTERN.test(String(resource.rows[0].active_deployment_id))) {
            await client.query(
              `UPDATE hosting_runtime_instances
               SET provider = 'podman', status = 'running', deployment_id = $2,
                   started_at = NOW(), stopped_at = NULL, updated_at = NOW()
               WHERE resource_id = $1`,
              [resourceId, resource.rows[0].active_deployment_id],
            );
          } else {
            await client.query("DELETE FROM hosting_runtime_instances WHERE resource_id = $1", [resourceId]);
          }
          await client.query("COMMIT");
          await syncPublishedNodeIngress();
        } catch (restoreError) {
          await client.query("ROLLBACK").catch(() => undefined);
          console.error("Could not restore previous ingress selection:", restoreError instanceof Error ? restoreError.message : restoreError);
        }
        return res.status(502).json({
          success: false,
          message: "The deployment could not be safely switched at the ingress layer. The previous runtime was retained and the active pointer was restored where possible.",
        });
      }
    }

    return res.json({
      success: true,
      message: "Deployment is now the live website version.",
      resource: updated.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Deployment activation error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not activate this deployment." });
  } finally {
    client.release();
  }
});

// Check a Node.js project's uploaded manifest without executing user code.
router.post("/:resourceId/validate-node", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }

  try {
    const resource = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (resource.rowCount !== 1) {
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }
    if (resource.rows[0].site_type !== "node") {
      return res.status(409).json({ success: false, message: "This validation is only available for Node.js websites." });
    }
    if (resource.rows[0].status === "archived") {
      return res.status(409).json({ success: false, message: "Restore this website before validating it." });
    }

    const files = await pool.query(
      `SELECT original_name, storage_key
       FROM hosting_files
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY original_name ASC`,
      [projectId, resourceId]
    );
    const uploadedPaths = files.rows.map((file: { original_name: string }) => file.original_name);
    const packageFile = files.rows.find((file: { original_name: string }) => file.original_name === "package.json");
    let packageJson = "";

    if (packageFile) {
      try {
        packageJson = (await websiteObjectStorage.get(packageFile.storage_key, { ownerId: String(resource.rows[0].owner_id), projectId, resourceId })).toString("utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const validation = validateNodeProject(packageJson, uploadedPaths);
    return res.status(validation.valid ? 200 : 422).json({
      success: validation.valid,
      validation,
      runtimeAvailable: false,
      runtime: {
        status: "unavailable",
        executionEnabled: false,
        providerConfigured: false,
        reason: "An isolated runtime provider is not configured. Customer backend code is never executed by this service.",
      },
      message: validation.valid
        ? "Node.js project configuration is valid. Execution remains disabled until isolated runtime support is installed."
        : validation.error,
    });
  } catch (error) {
    console.error("Node project validation error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not validate this Node.js project." });
  }
});



async function writeNodeSnapshotFile(bytes: Buffer, destination: string, expectedSize: number): Promise<number> {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== expectedSize || bytes.byteLength > 10 * 1024 * 1024) {
    throw new Error("A Node deployment source is not a permitted regular file.");
  }
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    return bytes.byteLength;
  } finally {
    await handle.close();
  }
}

/**
 * Node deployments are built remotely and activated only after the private
 * runtime agent confirms its readiness probe. No database transaction is held
 * open while the remote builder or runtime is working.
 */
async function deployNodeWebsite(
  projectId: string,
  resourceId: string,
  userId: string,
  response: import("express").Response,
) {
  const agent = runtimeAgentOptions();
  if (!agent) {
    return response.status(503).json({
      success: false,
      message: "The private Linux builder and runtime agent are not configured.",
    });
  }

  const client = await pool.connect();
  const deploymentId = randomUUID();
  const snapshotKeys: string[] = [];
  let snapshotManifest: ManifestFile[] = [];
  let runtimeStarted = false;
  let snapshotBytes = 0;
  try {
    await client.query("BEGIN");
    const resource = await client.query(
      `SELECT r.id, r.status, r.site_type, r.active_deployment_id, p.owner_id
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, userId],
    );
    if (resource.rowCount !== 1) {
      await client.query("ROLLBACK");
      return response.status(404).json({ success: false, message: "Website resource not found." });
    }
    if (resource.rows[0].site_type !== "node") {
      await client.query("ROLLBACK");
      return response.status(409).json({ success: false, message: "This deployment path is only for Node.js websites." });
    }
    if (resource.rows[0].status === "archived") {
      await client.query("ROLLBACK");
      return response.status(409).json({ success: false, message: "Restore this website before deploying." });
    }

    const previousActiveDeploymentId = resource.rows[0].active_deployment_id ?? null;

    const files = await client.query(
      `SELECT original_name, storage_key, mime_type, size_bytes
       FROM hosting_files
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY original_name ASC`,
      [projectId, resourceId],
    );
    const sourceFiles = files.rows as ManifestFile[];
    const uploadedPaths = sourceFiles.map((file) => file.original_name);
    const packageFile = sourceFiles.find((file) => file.original_name === "package.json");
    let packageJson = "";
    if (packageFile) {
      packageJson = (await websiteObjectStorage.get(packageFile.storage_key, { ownerId: String(resource.rows[0].owner_id), projectId, resourceId })).toString("utf8");
    }
    const validation = validateNodeProject(packageJson, uploadedPaths);
    if (!validation.valid) {
      await client.query("ROLLBACK");
      return response.status(422).json({ success: false, message: validation.error, validation });
    }
    if (sourceFiles.length < 1 || sourceFiles.length > 2_000) {
      await client.query("ROLLBACK");
      return response.status(422).json({ success: false, message: "Node deployment must contain between 1 and 2,000 files." });
    }

    await mkdir(path.join(storageRoot, resourceId), { recursive: true, mode: 0o700 });
    for (const file of sourceFiles) {
      const expectedSize = Number(file.size_bytes);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 10 * 1024 * 1024) {
        throw new Error("A stored website file has invalid deployment metadata.");
      }
      const bytes = await websiteObjectStorage.get(file.storage_key, { ownerId: String(resource.rows[0].owner_id), projectId, resourceId });
      const snapshotKey = randomUUID();
      snapshotKeys.push(snapshotKey);
      snapshotBytes += await writeNodeSnapshotFile(bytes, path.join(storageRoot, resourceId, snapshotKey), expectedSize);
      if (snapshotBytes > 100 * 1024 * 1024) throw new Error("Node deployment exceeds the 100 MB snapshot limit.");
      snapshotManifest.push({ ...file, storage_key: snapshotKey });
    }
    await client.query("COMMIT");

    const environmentRows = await pool.query(
      `SELECT name, encrypted_value AS ciphertext,
              encryption_iv AS iv, encryption_auth_tag AS "authTag"
       FROM hosting_environment_variables
       WHERE resource_id = $1
       ORDER BY name ASC`,
      [resourceId],
    );
    const started = await startBuiltRemoteNodeRuntime({
      resourceId,
      deploymentId,
      storageRoot,
      files: snapshotManifest.map((file) => ({
        originalName: file.original_name,
        storageKey: file.storage_key,
      })),
      validation,
      encryptedVariables: environmentRows.rows,
      hostingUserId: userId,
      agent,
    });
    runtimeStarted = true;

    await client.query("BEGIN");
    const currentResource = await client.query(
      `SELECT r.id, r.status, r.active_deployment_id
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, userId],
    );
    if (currentResource.rowCount !== 1 || currentResource.rows[0].status === "archived") {
      throw new Error("Website ownership or availability changed during deployment.");
    }
    if (String(currentResource.rows[0].active_deployment_id || "") !== String(previousActiveDeploymentId || "")) {
      throw new Error("A newer deployment became active while this build was running.");
    }
    const numberResult = await client.query(
      `SELECT COALESCE(MAX(deployment_number), 0) + 1 AS next_number
       FROM hosting_deployments WHERE resource_id = $1`,
      [resourceId],
    );
    const deploymentNumber = Number(numberResult.rows[0].next_number);
    const inserted = await client.query(
      `INSERT INTO hosting_deployments
         (id, project_id, resource_id, deployment_number, status, file_manifest,
          error_summary, finished_at, created_by)
       VALUES ($1, $2, $3, $4, 'succeeded', $5::jsonb, NULL, NOW(), $6)
       RETURNING id, project_id, resource_id, deployment_number, status,
                 file_manifest, error_summary, started_at, finished_at, created_at`,
      [deploymentId, projectId, resourceId, deploymentNumber, JSON.stringify(snapshotManifest), userId],
    );
    await client.query(
      `UPDATE hosting_resources
       SET active_deployment_id = $3, status = 'published', updated_at = NOW()
       WHERE id = $1 AND project_id = $2`,
      [resourceId, projectId, deploymentId],
    );
    await client.query(
      `INSERT INTO hosting_runtime_instances
         (resource_id, provider, status, deployment_id, started_at, stopped_at, updated_at)
       VALUES ($1, 'podman', 'running', $2, NOW(), NULL, NOW())
       ON CONFLICT (resource_id) DO UPDATE
       SET provider = 'podman', status = 'running', deployment_id = EXCLUDED.deployment_id,
           started_at = NOW(), stopped_at = NULL, updated_at = NOW()`,
      [resourceId, deploymentId],
    );
    await client.query("COMMIT");

    let ingressSynced = true;
    try {
      await syncPublishedNodeIngress();
    } catch (ingressError) {
      ingressSynced = false;
      console.error("Node deployment ingress synchronization failed:", ingressError instanceof Error ? ingressError.message : ingressError);

      // The deployment is built and healthy, but it must not be reported as
      // live when the public route did not switch. Restore the previous active
      // pointer before returning, while retaining this healthy version as a
      // successful deployment that an operator can retry/activate later.
      try {
        await client.query("BEGIN");
        const restoredResource = await client.query(
          `UPDATE hosting_resources
           SET active_deployment_id = $3, status = $4, updated_at = NOW()
           WHERE id = $1 AND project_id = $2 AND active_deployment_id = $5
           RETURNING id`,
          [resourceId, projectId, previousActiveDeploymentId, currentResource.rows[0].status, deploymentId],
        );
        if (restoredResource.rowCount !== 1) {
          await client.query("ROLLBACK");
          // A newer deployment won the race. Never overwrite its pointer or
          // runtime metadata with this older deployment's recovery state.
          await syncPublishedNodeIngress();
          throw new Error("A newer deployment changed the active version during ingress recovery.");
        }
        if (UUID_PATTERN.test(String(previousActiveDeploymentId || ""))) {
          await client.query(
            `INSERT INTO hosting_runtime_instances
               (resource_id, provider, status, deployment_id, started_at, stopped_at, updated_at)
             VALUES ($1, 'podman', 'running', $2, NOW(), NULL, NOW())
             ON CONFLICT (resource_id) DO UPDATE
             SET provider = 'podman', status = 'running', deployment_id = EXCLUDED.deployment_id,
                 started_at = NOW(), stopped_at = NULL, updated_at = NOW()`,
            [resourceId, previousActiveDeploymentId],
          );
        } else {
          await client.query("DELETE FROM hosting_runtime_instances WHERE resource_id = $1", [resourceId]);
        }
        await client.query("COMMIT");
        await syncPublishedNodeIngress();
      } catch (restoreError) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("Node deployment could not restore the previous ingress selection:", restoreError instanceof Error ? restoreError.message : restoreError);
      }
    }
    if (ingressSynced) await cleanupRetiredNodeRuntimes(resourceId, agent);

    if (!ingressSynced) {
      return response.status(502).json({
        success: false,
        message: "The new Node.js version built and passed readiness, but public ingress could not be switched. The previous version was restored where possible; the new healthy version was retained for a safe retry.",
        deployment: inserted.rows[0],
        runtime: { state: started.state, deploymentId: started.deploymentId },
        buildOutput: started.buildOutput,
        ingress: { synchronized: false },
      });
    }

    return response.status(201).json({
      success: true,
      message: "Node.js website built in isolation, started, health-checked and activated.",
      deployment: inserted.rows[0],
      runtime: { state: started.state, deploymentId: started.deploymentId },
      buildOutput: started.buildOutput,
      ingress: { synchronized: true },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (runtimeStarted) {
      await deleteRuntimeAgentRuntime(agent, resourceId, deploymentId).catch(() => undefined);
      await deleteRuntimeAgentArtifact(agent, deploymentId).catch(() => undefined);
    }
    for (const key of snapshotKeys) {
      await rm(path.join(storageRoot, resourceId, key), { force: true }).catch(() => undefined);
    }

    // Preserve a failed deployment history entry without changing the active
    // deployment pointer. Use a fresh short transaction and owner check.
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT r.id FROM hosting_resources r
         INNER JOIN projects p ON p.id = r.project_id
         WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
         FOR UPDATE OF r`,
        [resourceId, projectId, userId],
      );
      if (current.rowCount === 1) {
        const numberResult = await client.query(
          `SELECT COALESCE(MAX(deployment_number), 0) + 1 AS next_number
           FROM hosting_deployments WHERE resource_id = $1`,
          [resourceId],
        );
        await client.query(
          `INSERT INTO hosting_deployments
             (id, project_id, resource_id, deployment_number, status, file_manifest,
              error_summary, finished_at, created_by)
           VALUES ($1, $2, $3, $4, 'failed', $5::jsonb, $6, NOW(), $7)`,
          [
            deploymentId, projectId, resourceId, Number(numberResult.rows[0].next_number),
            JSON.stringify(snapshotManifest),
            "Deployment failed during isolated build, runtime startup or activation.",
            userId,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (historyError) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Could not record failed Node deployment:", historyError instanceof Error ? historyError.message : "Unknown error");
    }

    console.error("Node deployment failed:", error instanceof Error ? error.message : "Unknown error");
    return response.status(502).json({
      success: false,
      message: "Node.js deployment failed during isolated build, runtime startup or activation. The previous active deployment was not changed.",
    });
  } finally {
    client.release();
  }
}

// Create an immutable snapshot of validated static website files.
router.post("/:resourceId/deployments", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }


  let existingResource;
  try {
    existingResource = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
  } catch (error) {
    console.error("Deployment resource lookup failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not load website resource." });
  }
  if (existingResource.rowCount !== 1) {
    return res.status(404).json({ success: false, message: "Website resource not found." });
  }
  if (existingResource.rows[0].site_type === "node") {
    return deployNodeWebsite(projectId, resourceId, String(res.locals.userId || ""), res);
  }

  const client = await pool.connect();
  const snapshotObjectKeys: string[] = [];
  try {
    await client.query("BEGIN");

    const resource = await client.query(
      `SELECT r.id, r.project_id, r.status, r.site_type, p.owner_id
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, String(res.locals.userId || "")]
    );

    if (resource.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Website resource not found." });
    }
    if (resource.rows[0].site_type === "node") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Node.js execution is not enabled yet. This project can be configured, but cannot be deployed until isolated runtime support is available." });
    }
    if (resource.rows[0].status === "archived") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Restore this website before deploying." });
    }

    const files = await client.query(
      `SELECT original_name, storage_key, mime_type, size_bytes
       FROM hosting_files
       WHERE project_id = $1 AND resource_id = $2
       ORDER BY original_name ASC`,
      [projectId, resourceId]
    );
    const sourceFiles = files.rows as ManifestFile[];
    const homepageCandidates = getWebsiteFileCandidates("index.html", sourceFiles.map(file => file.original_name));
    const homepage = homepageCandidates.find(candidate => sourceFiles.some(file => file.original_name === candidate));
    let failure = "";

    if (!homepage) {
      failure = "Deployment failed: upload an index.html homepage at the website root.";
    }

    const numberResult = await client.query(
      `SELECT COALESCE(MAX(deployment_number), 0) + 1 AS next_number
       FROM hosting_deployments
       WHERE resource_id = $1`,
      [resourceId]
    );
    const deploymentNumber = Number(numberResult.rows[0].next_number);
    const deploymentId = randomUUID();
    let snapshotManifest: ManifestFile[] = [];

    if (!failure) {
      try {
        for (const file of sourceFiles) {
          const sourceBytes = await websiteObjectStorage.get(file.storage_key, { ownerId: String(resource.rows[0].owner_id), projectId, resourceId });
          const snapshotKey = randomUUID();
          const storedSnapshotKey = await websiteObjectStorage.put({
            ownerId: String(res.locals.userId || ""),
            projectId,
            resourceId,
            objectId: snapshotKey,
          }, sourceBytes, file.mime_type || "application/octet-stream");
          snapshotObjectKeys.push(storedSnapshotKey);
          snapshotManifest.push({ ...file, storage_key: storedSnapshotKey });
        }
      } catch (error) {
        failure = "Deployment failed while creating the immutable object-storage snapshot.";
        for (const key of snapshotObjectKeys.splice(0)) {
          await websiteObjectStorage.delete(key, { ownerId: String(res.locals.userId || ""), projectId, resourceId }).catch(() => undefined);
        }
        snapshotManifest = [];
        console.error("Deployment snapshot copy failed:", error instanceof Error ? error.message : error);
      }
    }

    const inserted = await client.query(
      `INSERT INTO hosting_deployments
         (id, project_id, resource_id, deployment_number, status, file_manifest,
          error_summary, finished_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), $8)
       RETURNING id, project_id, resource_id, deployment_number, status,
                 file_manifest, error_summary, started_at, finished_at, created_at`,
      [
        deploymentId,
        projectId,
        resourceId,
        deploymentNumber,
        failure ? "failed" : "succeeded",
        JSON.stringify(snapshotManifest),
        failure || null,
        String(res.locals.userId || ""),
      ]
    );

    await client.query("COMMIT");
    return res.status(failure ? 422 : 201).json({
      success: !failure,
      message: failure || "Website files validated and saved as an immutable deployment snapshot.",
      deployment: inserted.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    for (const key of snapshotObjectKeys) await websiteObjectStorage.delete(key, { ownerId: String(res.locals.userId || ""), projectId, resourceId }).catch(() => undefined);
    console.error("Deployment creation error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not complete this deployment." });
  } finally {
    client.release();
  }
});

export default router;
