import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { Pool } from "pg";
import path from "node:path";
import { verifyRuntimeAgentRequest, type RuntimeAgentAuthHeaders, type RuntimeAgentNonceStore } from "../../../d-hosting/server/src/services/runtime-agent-verifier.js";
import { deleteStoredArtifact, readStoredArtifact, storeRuntimeArtifact } from "./artifact-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 100 * 1024 * 1024;

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

function isRuntimeCreateRequest(value: unknown): value is {
  resourceId: string;
  deploymentId: string;
  artifact: { artifactId: string; sha256: string; sizeBytes: number; fileCount: number };
} {
  if (!isRecord(value) || !UUID.test(String(value.resourceId)) ||
      !UUID.test(String(value.deploymentId)) || !isRecord(value.artifact)) return false;
  const artifact = value.artifact;
  return UUID.test(String(artifact.artifactId)) &&
    /^[a-f0-9]{64}$/i.test(String(artifact.sha256)) &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    (artifact.sizeBytes as number) > 0 && (artifact.sizeBytes as number) <= MAX_BODY_BYTES &&
    Number.isInteger(artifact.fileCount) &&
    (artifact.fileCount as number) > 0 && (artifact.fileCount as number) <= 2_000;
}

class PostgresNonceStore implements RuntimeAgentNonceStore {
  constructor(private readonly pool: Pool) {}

  async claim(nonce: string, expiresAt: number): Promise<boolean> {
    await this.pool.query("DELETE FROM runtime_agent_nonces WHERE expires_at < NOW()");
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
}) {
  const app = express();
  const nonceStore = new PostgresNonceStore(input.pool);
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

  app.put("/v1/artifacts/:artifactId", async (request, response) => {
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

  app.post("/v1/runtimes", async (request, response) => {
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

    // Deliberately fail closed. No container provider is configured or trusted yet.
    response.status(503).json({ error: "Isolated runtime provider is not configured. Website execution remains disabled." });
  });

  app.delete("/v1/artifacts/:artifactId", async (request, response) => {
    const artifactId = request.params.artifactId;
    if (!UUID.test(artifactId)) {
      response.status(400).json({ error: "Artifact identifier is invalid." });
      return;
    }
    try {
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

async function start(): Promise<void> {
  const secret = requiredEnvironment("RUNTIME_AGENT_SHARED_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("RUNTIME_AGENT_SHARED_SECRET must contain at least 32 bytes.");
  }
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
  } catch (error) {
    await pool.end();
    throw error;
  }

  const app = createRuntimeAgentApp({ pool, secret, storageRoot });
  const port = Number(process.env.RUNTIME_AGENT_PORT || 5003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await pool.end();
    throw new Error("RUNTIME_AGENT_PORT must be a valid TCP port.");
  }
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`D Hosting Runtime Agent listening on port ${port}`);
    console.log("Runtime provider: disabled (customer code execution is blocked).");
  });
  const shutdown = () => {
    server.close(() => void pool.end());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  void start().catch((error: unknown) => {
    console.error("Could not start D Hosting Runtime Agent:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}
