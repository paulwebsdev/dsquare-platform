import { Router } from "express";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { getWebsiteFileCandidates } from "../services/website-file-resolution.js";
import { validateNodeProject } from "../services/node-project-validation.js";
import { startBuiltRemoteNodeRuntime } from "../services/remote-node-runtime.js";
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
    `SELECT r.id, r.project_id, r.status, r.site_type, r.active_deployment_id
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

// Read the actual isolated runtime state for an owned Node.js website.
router.get("/:resourceId/runtime", async (req, res) => {
  const { projectId = "", resourceId = "" } = params(req);
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(resourceId)) {
    return res.status(400).json({ success: false, message: "Invalid project or website ID." });
  }
  try {
    const owned = await ownedResource(projectId, resourceId, String(res.locals.userId || ""));
    if (owned.rowCount !== 1) return res.status(404).json({ success: false, message: "Website resource not found." });
    if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime controls are only available for Node.js websites." });
    const agent = runtimeAgentOptions();
    if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });

    const runtime = await getRuntimeAgentRuntime(agent, resourceId);
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
    if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime logs are only available for Node.js websites." });
    const agent = runtimeAgentOptions();
    if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });
    const result = await getRuntimeAgentLogs(agent, resourceId);
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
      if (owned.rows[0].site_type !== "node") return res.status(409).json({ success: false, message: "Runtime controls are only available for Node.js websites." });
      if (owned.rows[0].status === "archived") return res.status(409).json({ success: false, message: "Restore this website before changing its runtime." });
      const agent = runtimeAgentOptions();
      if (!agent) return res.status(503).json({ success: false, message: "The private runtime agent is not configured." });
      const runtime = await changeRuntimeAgentRuntimeState(agent, resourceId, action);
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
      `SELECT r.id, r.status
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

    const updated = await client.query(
      `UPDATE hosting_resources
       SET active_deployment_id = $3, status = 'published', updated_at = NOW()
       WHERE id = $1 AND project_id = $2
       RETURNING id, status, active_deployment_id`,
      [resourceId, projectId, deploymentId]
    );
    await client.query("COMMIT");
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

    if (packageFile && UUID_PATTERN.test(packageFile.storage_key)) {
      try {
        packageJson = await readFile(path.join(storageRoot, resourceId, packageFile.storage_key), "utf8");
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



async function copyNodeSnapshotFile(source: string, destination: string): Promise<number> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 10 * 1024 * 1024) {
    throw new Error("A Node deployment source is not a permitted regular file.");
  }
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const destinationHandle = await open(destination, "wx", 0o600);
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino ||
        opened.size !== metadata.size) {
      throw new Error("A Node deployment source changed while its snapshot was being created.");
    }
    const bytes = await sourceHandle.readFile();
    if (bytes.byteLength !== metadata.size) throw new Error("A Node deployment source changed while being copied.");
    await destinationHandle.writeFile(bytes);
    await destinationHandle.sync();
    return bytes.byteLength;
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
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
      `SELECT r.id, r.status, r.site_type
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
    if (packageFile && UUID_PATTERN.test(packageFile.storage_key)) {
      packageJson = await readFile(path.join(storageRoot, resourceId, packageFile.storage_key), "utf8");
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

    for (const file of sourceFiles) {
      if (!UUID_PATTERN.test(file.storage_key)) throw new Error("A stored website file has an invalid storage key.");
      const source = path.join(storageRoot, resourceId, file.storage_key);
      if (!existsSync(source)) throw new Error("A stored website file is missing.");
      const snapshotKey = randomUUID();
      snapshotKeys.push(snapshotKey);
      snapshotBytes += await copyNodeSnapshotFile(source, path.join(storageRoot, resourceId, snapshotKey));
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
      `SELECT r.id, r.status
       FROM hosting_resources r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 AND r.project_id = $2 AND p.owner_id = $3
       FOR UPDATE OF r`,
      [resourceId, projectId, userId],
    );
    if (currentResource.rowCount !== 1 || currentResource.rows[0].status === "archived") {
      throw new Error("Website ownership or availability changed during deployment.");
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

    return response.status(201).json({
      success: true,
      message: "Node.js website built in isolation, started, health-checked and activated.",
      deployment: inserted.rows[0],
      runtime: { state: started.state, deploymentId: started.deploymentId },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (runtimeStarted) {
      await deleteRuntimeAgentRuntime(agent, resourceId).catch(() => undefined);
      await deleteRuntimeAgentArtifact(agent, deploymentId).catch(() => undefined);
    }
    for (const key of snapshotKeys) {
      await rm(path.join(storageRoot, resourceId, key), { force: true }).catch(() => undefined);
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
  let snapshotDirectory = "";
  try {
    await client.query("BEGIN");

    const resource = await client.query(
      `SELECT r.id, r.project_id, r.status, r.site_type
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
    } else {
      const missing = sourceFiles.find(file =>
        !UUID_PATTERN.test(file.storage_key) ||
        !existsSync(path.join(storageRoot, resourceId, file.storage_key))
      );
      if (missing) failure = `Deployment failed: stored file is missing (${missing.original_name}).`;
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
      snapshotDirectory = path.join(storageRoot, resourceId, "deployments", deploymentId);
      await mkdir(snapshotDirectory, { recursive: true });
      try {
        for (const file of sourceFiles) {
          const snapshotKey = randomUUID();
          await copyFile(
            path.join(storageRoot, resourceId, file.storage_key),
            path.join(snapshotDirectory, snapshotKey)
          );
          snapshotManifest.push({ ...file, storage_key: snapshotKey });
        }
      } catch (error) {
        failure = "Deployment failed while creating the immutable file snapshot.";
        await rm(snapshotDirectory, { recursive: true, force: true });
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
    if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
    console.error("Deployment creation error:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: "Could not complete this deployment." });
  } finally {
    client.release();
  }
});

export default router;
