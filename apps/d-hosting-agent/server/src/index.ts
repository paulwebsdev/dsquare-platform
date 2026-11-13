import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { Pool } from "pg";
import path from "node:path";
import { isIP } from "node:net";
import { verifyRuntimeAgentRequest, type RuntimeAgentAuthHeaders, type RuntimeAgentNonceStore } from "../../../d-hosting/server/src/services/runtime-agent-verifier.js";
import { deleteStoredArtifact, readStoredArtifact, storeRuntimeArtifact } from "./artifact-store.js";
import { PodmanRuntimeProvider } from "./podman-runtime-provider.js";
import { createPodmanSocketTransport } from "./podman-client.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { PodmanNodeBuildRunner, type NodeBuildRequest } from "./node-build-runner.js";
import { redactRuntimeLogMessage } from "../../../d-hosting/server/src/services/runtime-logs.js";
import { applyPrivateIngressConfig, renderPrivateIngressJsonConfig, type PrivateIngressJsonRoute } from "./private-ingress-controller.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 100 * 1024 * 1024;

export function resolveRuntimeAgentHost(value?: string): string {
  const host = value?.trim() || "127.0.0.1";
  if (isIP(host) === 0) {
    throw new Error("RUNTIME_AGENT_HOST must be a valid IPv4 or IPv6 address.");
  }
  return host;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required runtime agent setting: ${name}`);
  return value;
}

function getRawBody(request: Request): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTrustedRuntimeImage(image: string, trustedImage?: string): boolean {
  const approvedImage = trustedImage?.trim();
  return Boolean(approvedImage) && image === approvedImage;
}

export function isRuntimeCreateRequest(value: unknown): value is {
  resourceId: string;
  deploymentId: string;
  artifact: { artifactId: string; sha256: string; sizeBytes: number; fileCount: number };
  runtime: {
    name: string;
    image: string;
    workingDirectory: "/app";
    command: ["npm", "start"];
    environment: Record<string, string>;
    memoryBytes: number;
    nanoCpus: number;
    pidsLimit: number;
    user: "10001:10001";
    readOnlyRootFilesystem: true;
    capDrop: ["ALL"];
    securityOpt: ["no-new-privileges:true"];
    tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" };
  };
} {
  if (!isRecord(value) || !UUID.test(String(value.resourceId)) ||
      !UUID.test(String(value.deploymentId)) || !isRecord(value.artifact) ||
      !isRecord(value.runtime)) return false;

  const artifact = value.artifact;
  const runtime = value.runtime;
  if (!UUID.test(String(artifact.artifactId)) ||
      !/^[a-f0-9]{64}$/i.test(String(artifact.sha256)) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      (artifact.sizeBytes as number) < 1 || (artifact.sizeBytes as number) > MAX_BODY_BYTES ||
      !Number.isInteger(artifact.fileCount) ||
      (artifact.fileCount as number) < 1 || (artifact.fileCount as number) > 2_000) return false;

  if (runtime.name !== `dsquare-deploy-${value.deploymentId}` ||
      typeof runtime.image !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{2,255}$/.test(runtime.image) ||
      runtime.workingDirectory !== "/app" ||
      !Array.isArray(runtime.command) || runtime.command.length !== 2 ||
      runtime.command[0] !== "npm" || runtime.command[1] !== "start" ||
      !isRecord(runtime.environment) || runtime.environment.PORT !== "3000" ||
      !Number.isSafeInteger(runtime.memoryBytes) ||
      (runtime.memoryBytes as number) < 64 * 1024 * 1024 ||
      !Number.isSafeInteger(runtime.nanoCpus) ||
      (runtime.nanoCpus as number) < 100_000_000 ||
      !Number.isInteger(runtime.pidsLimit) ||
      (runtime.pidsLimit as number) < 16 || (runtime.pidsLimit as number) > 1024 ||
      runtime.user !== "10001:10001" ||
      runtime.readOnlyRootFilesystem !== true ||
      !Array.isArray(runtime.capDrop) || runtime.capDrop.length !== 1 ||
      runtime.capDrop[0] !== "ALL" ||
      !Array.isArray(runtime.securityOpt) || runtime.securityOpt.length !== 1 ||
      runtime.securityOpt[0] !== "no-new-privileges:true" ||
      !isRecord(runtime.tmpfs) ||
      runtime.tmpfs["/tmp"] !== "rw,noexec,nosuid,size=64m") return false;

  for (const [name, envValue] of Object.entries(runtime.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof envValue !== "string" || envValue.length > 16_384) return false;
    if (name === "PORT" && envValue !== "3000") return false;
  }
  return true;
}

class PostgresNonceStore implements RuntimeAgentNonceStore {
  constructor(private readonly pool: Pool) {}

  async claim(nonce: string, expiresAt: number): Promise<boolean> {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return false;
    }
    await this.pool.query(`
      DELETE FROM runtime_agent_nonces
      WHERE nonce IN (
        SELECT nonce FROM runtime_agent_nonces
        WHERE expires_at < NOW()
        ORDER BY expires_at
        LIMIT 500
      )
    `);
    const result = await this.pool.query(
      `INSERT INTO runtime_agent_nonces (nonce, expires_at)
       VALUES ($1, to_timestamp($2 / 1000.0))
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [nonce, expiresAt],
    );
    return result.rowCount === 1;
  }
}

export function createRuntimeAgentApp(input: {
  pool: Pool;
  secret: string;
  storageRoot: string;
  provider?: PodmanRuntimeProvider;
  builder?: PodmanNodeBuildRunner;
  builderEnabled?: boolean;
  ingressAdminUrl?: string;
  trustedImage?: string;
  /** Must remain false in production until Linux isolation acceptance is complete. */
  executionEnabled?: boolean;
}) {
  const app = express();
  const nonceStore = new PostgresNonceStore(input.pool);
  const registry = new RuntimeRegistry(input.pool);
  const executionEnabled = input.executionEnabled === true && Boolean(input.provider);
  const builderEnabled = input.builderEnabled === true && Boolean(input.builder);
  app.disable("x-powered-by");
  app.use(express.raw({
    type: "*/*",
    limit: MAX_BODY_BYTES,
  }));

  app.use(async (request: Request, response: Response, next: NextFunction) => {
    if (!request.originalUrl.startsWith("/v1/")) {
      next();
      return;
    }
    try {
      if (request.originalUrl.includes("?")) {
        response.status(400).json({ error: "Runtime agent query strings are not permitted." });
        return;
      }
      await verifyRuntimeAgentRequest({
        method: request.method,
        pathname: request.originalUrl,
        rawBody: getRawBody(request),
        headers: request.headers as RuntimeAgentAuthHeaders,
        secret: input.secret,
        nonceStore,
      });
      next();
    } catch {
      response.status(401).json({ error: "Runtime agent authentication failed." });
    }
  });

  app.get("/v1/health", (_request, response) => {
    response.status(200).json({ status: "ready", providerConfigured: Boolean(input.provider), executionEnabled, builderConfigured: Boolean(input.builder), builderEnabled, ingressConfigured: Boolean(input.ingressAdminUrl) });
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_request, response) => {
    try {
      await input.pool.query("SELECT 1");
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "not_ready" });
    }
  });

  app.put("/v1/artifacts/:artifactId", async (request, response) => {
    if (request.headers["content-type"] !== "application/vnd.dsquare.runtime-artifact") {
      response.status(415).json({ error: "Runtime artifact content type is not supported." });
      return;
    }
    const artifactId = request.params.artifactId;
    if (!UUID.test(artifactId)) {
      response.status(400).json({ error: "Artifact identifier is invalid." });
      return;
    }
    try {
      const artifact = await storeRuntimeArtifact(input.storageRoot, artifactId, getRawBody(request));
      response.status(201).json({ artifactId: artifact.artifactId, accepted: true });
    } catch {
      response.status(400).json({ error: "Runtime artifact was rejected." });
    }
  });

  app.post("/v1/ingress/routes", async (request, response) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      response.status(415).json({ error: "Ingress route updates must use application/json." });
      return;
    }
    if (!input.ingressAdminUrl) {
      response.status(503).json({ error: "The private Caddy ingress admin endpoint is not configured." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(getRawBody(request).toString("utf8"));
    } catch {
      response.status(400).json({ error: "Ingress route update must contain valid JSON." });
      return;
    }
    if (!isRecord(payload) || !Array.isArray(payload.routes) || payload.routes.length > 2_000 ||
        (payload.tlsEmail !== undefined && typeof payload.tlsEmail !== "string")) {
      response.status(400).json({ error: "Ingress route update payload is invalid." });
      return;
    }
    const routes: PrivateIngressJsonRoute[] = [];
    for (const value of payload.routes) {
      if (!isRecord(value) || typeof value.domain !== "string" ||
          typeof value.resourceId !== "string" || typeof value.deploymentId !== "string") {
        response.status(400).json({ error: "Ingress route entry is invalid." });
        return;
      }
      routes.push({
        domain: value.domain,
        resourceId: value.resourceId,
        deploymentId: value.deploymentId,
      });
    }
    try {
      const config = renderPrivateIngressJsonConfig(routes, payload.tlsEmail as string | undefined);
      await applyPrivateIngressConfig({ adminUrl: input.ingressAdminUrl, config });
      response.status(200).json({ applied: true, routeCount: routes.length });
    } catch (error) {
      console.error("Private ingress update failed:", error instanceof Error ? error.message : "Unknown error");
      response.status(502).json({ error: "Private ingress configuration could not be applied." });
    }
  });

  app.post("/v1/builds", async (request, response) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      response.status(415).json({ error: "Node build request must use application/json." });
      return;
    }
    if (!builderEnabled || !input.builder) {
      response.status(503).json({ error: "The isolated Node builder is not enabled on this agent." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(getRawBody(request).toString("utf8"));
    } catch {
      response.status(400).json({ error: "Node build request must contain valid JSON." });
      return;
    }
    if (!isRecord(payload) || !UUID.test(String(payload.sourceArtifactId)) ||
        !UUID.test(String(payload.deploymentId)) || payload.sourceArtifactId === payload.deploymentId ||
        (payload.cacheAttestation !== undefined && !isRecord(payload.cacheAttestation))) {
      response.status(400).json({ error: "Node build request identity or cache attestation is invalid." });
      return;
    }
    try {
      const result = await input.builder.build(payload as unknown as NodeBuildRequest);
      response.status(201).json({
        artifact: {
          artifactId: result.artifactId,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          fileCount: result.fileCount,
        },
        output: result.output.split(/\r?\n/).map(redactRuntimeLogMessage).join("\n").slice(-64 * 1024),
      });
    } catch (error) {
      console.error("Isolated Node build failed:", error instanceof Error ? error.message : "Unknown error");
      response.status(422).json({ error: "The isolated Node build failed validation, execution or artifact packaging." });
    }
  });

  app.post("/v1/runtimes", async (request, response) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      response.status(415).json({ error: "Runtime request must use application/json." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(getRawBody(request).toString("utf8"));
    } catch {
      response.status(400).json({ error: "Runtime request must contain valid JSON." });
      return;
    }
    if (!isRuntimeCreateRequest(payload)) {
      response.status(400).json({ error: "Runtime creation request is invalid." });
      return;
    }
    const stored = await readStoredArtifact(input.storageRoot, payload.artifact.artifactId);
    if (!stored || stored.sha256 !== payload.artifact.sha256 ||
        stored.sizeBytes !== payload.artifact.sizeBytes ||
        stored.fileCount !== payload.artifact.fileCount ||
        payload.deploymentId !== payload.artifact.artifactId) {
      response.status(409).json({ error: "Runtime artifact is missing or does not match the request." });
      return;
    }

    const trustedImage = input.trustedImage ?? process.env.RUNTIME_AGENT_TRUSTED_IMAGE;
    if (!isTrustedRuntimeImage(payload.runtime.image, trustedImage)) {
      response.status(trustedImage?.trim() ? 400 : 503).json({
        error: trustedImage?.trim()
          ? "Runtime image is not the configured trusted image."
          : "Runtime creation is unavailable because no trusted image is configured.",
      });
      return;
    }
    if (!executionEnabled || !input.provider) {
      response.status(503).json({ error: "Website execution is disabled pending Linux isolation acceptance." });
      return;
    }
    const reserved = await registry.reserveDeployment({
      resourceId: payload.resourceId,
      deploymentId: payload.deploymentId,
      artifactId: payload.artifact.artifactId,
    });
    if (!reserved) {
      const existing = await registry.getDeployment(payload.deploymentId);
      if (existing?.resourceId === payload.resourceId &&
          existing.deploymentId === payload.deploymentId &&
          existing.artifactId === payload.artifact.artifactId &&
          existing.state === "running" && existing.containerId) {
        response.status(200).json({
          resourceId: existing.resourceId,
          deploymentId: existing.deploymentId,
          state: "running",
        });
        return;
      }
      response.status(409).json({ error: "A runtime is already being created or exists for this resource or deployment." });
      return;
    }

    let created: { containerId: string; workspacePath: string };
    try {
      created = await input.provider.createAndStart({
        resourceId: payload.resourceId,
        deploymentId: payload.deploymentId,
        artifactId: payload.artifact.artifactId,
        runtime: payload.runtime,
      });
    } catch {
      await registry.deleteDeployment(payload.deploymentId).catch(() => undefined);
      response.status(502).json({ error: "Isolated runtime could not be created; the reservation was released." });
      return;
    }

    let persisted = false;
    try {
      persisted = await registry.completeDeployment(payload.deploymentId, created.containerId);
    } catch {
      persisted = false;
    }
    if (!persisted) {
      await input.provider.remove(created.containerId, payload.artifact.artifactId).catch(() => false);
      await registry.deleteDeployment(payload.deploymentId).catch(() => undefined);
      response.status(503).json({ error: "Runtime state could not be finalized; the container rollback was attempted." });
      return;
    }
    response.status(201).json({
      resourceId: payload.resourceId,
      deploymentId: payload.deploymentId,
      state: "running",
    });
  });

  app.get("/v1/runtimes/:resourceId/:deploymentId", async (request, response) => {
    if (!UUID.test(request.params.resourceId) || !UUID.test(request.params.deploymentId)) {
      response.status(400).json({ error: "Runtime resource identifier is invalid." });
      return;
    }
    const record = await registry.getDeployment(request.params.deploymentId);
    if (!record || record.resourceId !== request.params.resourceId) {
      response.status(404).json({ error: "Runtime was not found." });
      return;
    }
    if (!record.containerId) {
      response.status(409).json({ error: "Runtime creation is still in progress." });
      return;
    }
    if (!executionEnabled || !input.provider) {
      response.status(503).json({ error: "Runtime provider is unavailable." });
      return;
    }
    try {
      const inspected = await input.provider.inspect(record.containerId);
      const state = isRecord(inspected.State) && inspected.State.Status === "running"
        ? "running" : "stopped";
      await registry.setDeploymentState(record.deploymentId, state);
      response.status(200).json({
        resourceId: record.resourceId,
        deploymentId: record.deploymentId,
        state,
      });
    } catch {
      response.status(502).json({ error: "Runtime status could not be retrieved." });
    }
  });

  app.get("/v1/runtimes/:resourceId/:deploymentId/logs", async (request, response) => {
    if (!UUID.test(request.params.resourceId) || !UUID.test(request.params.deploymentId)) {
      response.status(400).json({ error: "Runtime resource identifier is invalid." });
      return;
    }
    if (!executionEnabled || !input.provider) {
      response.status(503).json({ error: "Runtime provider is unavailable." });
      return;
    }
    const record = await registry.getDeployment(request.params.deploymentId);
    if (!record || record.resourceId !== request.params.resourceId) {
      response.status(404).json({ error: "Runtime was not found." });
      return;
    }
    if (!record.containerId) {
      response.status(409).json({ error: "Runtime creation is still in progress." });
      return;
    }
    try {
      const logs = await input.provider.logs(record.containerId, 200);
      const safeLogs = logs.toString("utf8").split(/\r?\n/).slice(-200)
        .map(redactRuntimeLogMessage).join("\n");
      response.status(200).json({ resourceId: record.resourceId, deploymentId: record.deploymentId, logs: safeLogs });
    } catch {
      response.status(502).json({ error: "Runtime logs could not be retrieved." });
    }
  });

  for (const action of ["stop", "restart"] as const) {
    app.post(`/v1/runtimes/:resourceId/:deploymentId/${action}`, async (request, response) => {
      if (getRawBody(request).byteLength !== 0 || !UUID.test(request.params.resourceId) || !UUID.test(request.params.deploymentId)) {
        response.status(400).json({ error: "Runtime lifecycle request is invalid." });
        return;
      }
      if (!executionEnabled || !input.provider) {
        response.status(503).json({ error: "Website execution is disabled pending Linux isolation acceptance." });
        return;
      }
      const record = await registry.getDeployment(request.params.deploymentId);
      if (!record || record.resourceId !== request.params.resourceId) {
        response.status(404).json({ error: "Runtime was not found." });
        return;
      }
      if (!record.containerId) {
        response.status(409).json({ error: "Runtime creation is still in progress." });
        return;
      }
      try {
        if (action === "stop") await input.provider.stop(record.containerId);
        else await input.provider.restart(record.containerId);
        const state = action === "stop" ? "stopped" : "running";
        await registry.setDeploymentState(record.deploymentId, state);
        response.status(200).json({ resourceId: record.resourceId, deploymentId: record.deploymentId, state });
      } catch {
        response.status(502).json({ error: "Runtime lifecycle operation failed." });
      }
    });
  }

  app.delete("/v1/runtimes/:resourceId/:deploymentId", async (request, response) => {
    if (getRawBody(request).byteLength !== 0 || !UUID.test(request.params.resourceId) || !UUID.test(request.params.deploymentId)) {
      response.status(400).json({ error: "Runtime deletion request is invalid." });
      return;
    }
    if (!executionEnabled || !input.provider) {
      response.status(503).json({ error: "Website execution is disabled pending Linux isolation acceptance." });
      return;
    }
    const record = await registry.getDeployment(request.params.deploymentId);
    if (!record || record.resourceId !== request.params.resourceId) {
      response.status(404).json({ error: "Runtime was not found." });
      return;
    }
    if (!record.containerId) {
      await registry.deleteDeployment(record.deploymentId);
      response.status(200).json({ resourceId: record.resourceId, deploymentId: record.deploymentId, deleted: true });
      return;
    }
    try {
      await input.provider.remove(record.containerId, record.artifactId);
      await registry.deleteDeployment(record.deploymentId);
      response.status(200).json({ resourceId: record.resourceId, deploymentId: record.deploymentId, deleted: true });
    } catch {
      response.status(502).json({ error: "Runtime could not be safely removed." });
    }
  });

  app.delete("/v1/artifacts/:artifactId", async (request, response) => {
    if (getRawBody(request).byteLength !== 0) {
      response.status(400).json({ error: "Artifact deletion requests cannot contain a body." });
      return;
    }
    const artifactId = request.params.artifactId;
    if (!UUID.test(artifactId)) {
      response.status(400).json({ error: "Artifact identifier is invalid." });
      return;
    }
    try {
      const [deployments, legacyRuntimes] = await Promise.all([
        registry.listDeployments(),
        registry.list(),
      ]);
      if ([...deployments, ...legacyRuntimes].some((runtime) => runtime.artifactId === artifactId)) {
        response.status(409).json({ error: "Runtime artifact is still referenced by a managed deployment." });
        return;
      }
      const deleted = await deleteStoredArtifact(input.storageRoot, artifactId);
      response.status(deleted ? 200 : 404).json({ artifactId, deleted });
    } catch {
      response.status(409).json({ error: "Artifact could not be safely removed." });
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Runtime agent endpoint not found." });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = isRecord(error) && error.type === "entity.too.large" ? 413 : 500;
    response.status(status).json({ error: status === 413 ? "Request body exceeds the permitted limit." : "Runtime agent request failed." });
  });

  return app;
}



export async function startRuntimeAgent(): Promise<void> {
  const secret = requiredEnvironment("RUNTIME_AGENT_SHARED_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("RUNTIME_AGENT_SHARED_SECRET must contain at least 32 bytes.");
  }
  const host = resolveRuntimeAgentHost(process.env.RUNTIME_AGENT_HOST);
  const databaseUrl = requiredEnvironment("RUNTIME_AGENT_DATABASE_URL");
  const storageRoot = path.resolve(requiredEnvironment("RUNTIME_AGENT_STORAGE_ROOT"));
  const pool = new Pool({
    connectionString: databaseUrl,
    ...(process.env.RUNTIME_AGENT_DB_SSL === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "dsquare-hosting-runtime-agent",
  });
  pool.on("error", (error) => {
    console.error("Runtime agent database pool error:", error.message);
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_agent_nonces (
        nonce UUID PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS runtime_agent_nonces_expires_at_idx ON runtime_agent_nonces (expires_at)");
    await pool.query("SELECT 1");
    await new RuntimeRegistry(pool).initialize();
  } catch (error) {
    await pool.end();
    throw error;
  }

  // Production execution is deliberately hard-disabled until Linux acceptance tests pass.
  const podmanSocket = process.env.RUNTIME_AGENT_PODMAN_SOCKET?.trim();
  const trustedImage = process.env.RUNTIME_AGENT_TRUSTED_IMAGE?.trim();
  const privateNetwork = process.env.RUNTIME_AGENT_PODMAN_NETWORK?.trim();
  const runtimeRootValue = process.env.RUNTIME_AGENT_RUNTIME_ROOT?.trim();
  const persistentStorageRootValue = process.env.RUNTIME_AGENT_PERSISTENT_STORAGE_ROOT?.trim();
  const containerRuntimeRoot = process.env.RUNTIME_AGENT_CONTAINER_RUNTIME_ROOT?.trim();
  let provider: PodmanRuntimeProvider | undefined;
  let builder: PodmanNodeBuildRunner | undefined;
  let builderEnabled = false;
  const builderWorkspaceRootValue = process.env.RUNTIME_AGENT_BUILDER_WORKSPACE_ROOT?.trim();
  const npmCacheRootValue = process.env.RUNTIME_AGENT_NPM_CACHE_ROOT?.trim();
  const containerStorageRoot = process.env.RUNTIME_AGENT_CONTAINER_STORAGE_ROOT?.trim();
  const containerBuilderWorkspaceRoot = process.env.RUNTIME_AGENT_CONTAINER_BUILDER_WORKSPACE_ROOT?.trim();
  const containerNpmCacheRoot = process.env.RUNTIME_AGENT_CONTAINER_NPM_CACHE_ROOT?.trim();
  const builderSigningKey = process.env.RUNTIME_AGENT_BUILDER_CACHE_SIGNING_KEY;
  if (podmanSocket && trustedImage && privateNetwork && runtimeRootValue && persistentStorageRootValue && containerRuntimeRoot) {
    if (!podmanSocket.startsWith("/") || !runtimeRootValue.startsWith("/") || !persistentStorageRootValue.startsWith("/") || /[\\r\\n\\0:,]/.test(persistentStorageRootValue) ||
        !path.posix.isAbsolute(containerRuntimeRoot) ||
        /[\r\n\0:]/.test(containerRuntimeRoot)) {
      await pool.end();
      throw new Error("Podman socket and runtime workspace paths must be Linux absolute paths.");
    }
    provider = new PodmanRuntimeProvider({
      transport: createPodmanSocketTransport({ socketPath: podmanSocket }),
      storageRoot,
      runtimeRoot: path.resolve(runtimeRootValue),
      persistentStorageRoot: path.resolve(persistentStorageRootValue),
      trustedImage,
      networkName: privateNetwork,
      containerWorkspacePath: (_workspacePath, artifactId) =>
        path.posix.join(containerRuntimeRoot, artifactId),
    });
  }
  const builderConfigured = Boolean(
    podmanSocket && builderWorkspaceRootValue && npmCacheRootValue &&
    containerStorageRoot && containerBuilderWorkspaceRoot && containerNpmCacheRoot &&
    builderSigningKey && Buffer.byteLength(builderSigningKey, "utf8") >= 32 &&
    process.env.RUNTIME_AGENT_NPM_REGISTRY_EGRESS_RESTRICTED === "true"
  );
  if (builderConfigured) {
    const roots = [
      builderWorkspaceRootValue!, npmCacheRootValue!, containerStorageRoot!,
      containerBuilderWorkspaceRoot!, containerNpmCacheRoot!,
    ];
    if (roots.some((value) => !path.posix.isAbsolute(value) || /[\\r\\n\\0:]/.test(value))) {
      await pool.end();
      throw new Error("Builder host and container mount roots must be safe absolute Linux paths.");
    }
    const transport = createPodmanSocketTransport({ socketPath: podmanSocket! });
    const mapContainerPath = (hostPath: string): string => {
      const absolute = path.resolve(hostPath);
      const mappings = [
        { host: storageRoot, container: containerStorageRoot! },
        { host: path.resolve(builderWorkspaceRootValue!), container: containerBuilderWorkspaceRoot! },
        { host: path.resolve(npmCacheRootValue!), container: containerNpmCacheRoot! },
      ];
      for (const mapping of mappings) {
        const relative = path.relative(mapping.host, absolute);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
          return relative
            ? path.posix.join(mapping.container, ...relative.split(path.sep))
            : mapping.container;
        }
      }
      throw new Error("Builder mount path is outside the configured Podman host roots.");
    };
    builder = new PodmanNodeBuildRunner({
      transport,
      storageRoot,
      workspaceRoot: path.resolve(builderWorkspaceRootValue!),
      cacheRoot: path.resolve(npmCacheRootValue!),
      signingKey: builderSigningKey!,
      containerPath: mapContainerPath,
      allowRegistryEgress: true,
    });
    builderEnabled = process.env.RUNTIME_AGENT_BUILDER_ENABLED === "true";
  }

  const registry = new RuntimeRegistry(pool);
  try {
    if (builder) {
      const removedBuilders = await builder.reconcile();
      console.log(`Builder recovery: removed ${removedBuilders} abandoned build containers.`);
    }
    if (provider) {
      const recovered = await provider.reconcile(registry);
      console.log(`Runtime recovery: adopted ${recovered.adopted}, removed ${recovered.removed} orphaned containers.`);
    }
    await registry.clearStaleReservations();
  } catch (error) {
    await pool.end();
    throw error;
  }

  // Production execution is deliberately hard-disabled until Linux acceptance tests pass.
  const ingressAdminUrl = process.env.RUNTIME_AGENT_CADDY_ADMIN_URL?.trim();
  const app = createRuntimeAgentApp({ pool, secret, storageRoot, provider, builder, builderEnabled, ingressAdminUrl, executionEnabled: false });
  const port = Number(process.env.RUNTIME_AGENT_PORT || 5003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await pool.end();
    throw new Error("RUNTIME_AGENT_PORT must be a valid TCP port.");
  }
  const server = app.listen(port, host, () => {
    console.log(`D Hosting Runtime Agent listening on port ${port}`);
    console.log("Runtime provider: disabled (customer runtime execution is blocked).");
    console.log(`Isolated builder: ${builderEnabled ? "enabled" : "disabled"}.`);
    console.log(`Private ingress controller: ${ingressAdminUrl ? "configured" : "disabled"}.`);
  });
  const shutdown = () => {
    server.close(() => void pool.end());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
