import "dotenv/config";
import databaseConnectionsRouter from "./routes/database-connections.js";
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationPool, pool } from "./config/database.js";
import { runMigrations } from "./db/migrate.js";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import hostingResourcesRouter from "./routes/hosting-resources.js";
import hostingResourceDatabaseConnectionRouter from "./routes/hosting-resource-database-connection.js";
import hostingEnvironmentRouter from "./routes/hosting-environment.js";
import hostingFilesRouter from "./routes/hosting-files.js";
import hostingStorageRouter from "./routes/hosting-storage.js";
import hostingDeploymentsRouter from "./routes/hosting-deployments.js";
import hostingPreviewRouter from "./routes/hosting-preview.js";
import hostingDomainsRouter from "./routes/hosting-domains.js";
import hostingDomainSiteRouter from "./routes/hosting-domain-site.js";
import { assertWebsiteObjectStorageConfigured } from "./services/website-object-storage.js";
import { startHostingBackupScheduler } from "./services/platform-backup-worker.js";

const app = express();
app.set("trust proxy", 1);

const clientDistPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const clientIndexPath = resolve(clientDistPath, "index.html");

function isProductHost(hostname: string): boolean {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return hostname === process.env.RENDER_EXTERNAL_HOSTNAME;
  }

  return process.env.NODE_ENV !== "production" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

function getAllowedAppOrigin(): string {
  const configured = process.env.D_HOSTING_APP_ORIGIN?.trim();
  const value = configured || (
    process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5174"
  );

  if (!value) {
    throw new Error("D_HOSTING_APP_ORIGIN must be set in production.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("D_HOSTING_APP_ORIGIN must be a valid origin.");
  }

  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);

  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (process.env.NODE_ENV === "production"
      ? parsed.protocol !== "https:"
      : parsed.protocol !== "https:" && !isLoopbackHttp)
  ) {
    throw new Error("D_HOSTING_APP_ORIGIN must be a secure HTTPS origin (HTTP loopback is allowed only in development).");
  }

  return parsed.origin;
}

const APP_ORIGIN = getAllowedAppOrigin();

app.use(cors({
  origin: APP_ORIGIN,
  credentials: true,
}));

app.use(express.json());

// Custom-domain website delivery runs before the authenticated product API.
app.use("/", hostingDomainSiteRouter);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/database-connections", databaseConnectionsRouter);

// Public website routes must run before routers with global authentication middleware.
app.use("/api/v1/projects/:projectId/resources", hostingPreviewRouter);
app.use("/api/v1/projects/:projectId/resources", hostingDomainsRouter);
app.use("/api/v1/projects/:projectId/resources", hostingResourcesRouter);
app.use("/api/v1/projects/:projectId/resources", hostingResourceDatabaseConnectionRouter);
app.use("/api/v1/projects/:projectId/resources", hostingEnvironmentRouter);
app.use("/api/v1/projects/:projectId/resources", hostingFilesRouter);
app.use("/api/v1/projects/:projectId/resources", hostingStorageRouter);
app.use("/api/v1/projects/:projectId/resources", hostingDeploymentsRouter);

// Project routes have global authentication and must follow the public website routes.
app.use("/api/v1/projects", projectsRouter);

app.get("/api/v1/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      product: "D Hosting",
      api: "online",
      database: { connected: true },
    });
  } catch (error) {
    console.error(
      "D Hosting health check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    res.status(503).json({
      success: false,
      product: "D Hosting",
      database: { connected: false },
      message: "Database connection unavailable",
    });
  }
});

const serveClient = express.static(clientDistPath, { index: false, maxAge: "1h" });
app.use((req, res, next) => {
  if (!isProductHost(req.hostname)) return next();
  serveClient(req, res, next);
});
app.use((req, res, next) => {
  if (
    !isProductHost(req.hostname) ||
    !["GET", "HEAD"].includes(req.method) ||
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  res.sendFile(clientIndexPath, (error) => {
    if (error) next(error);
  });
});

const PORT = Number(process.env.PORT || 5002);

async function startServer() {
  try {
    if (process.env.NODE_ENV === "production" && !existsSync(clientIndexPath)) {
      throw new Error("D Hosting frontend build is missing. Build the client before starting the server.");
    }

    assertWebsiteObjectStorageConfigured();
    if (process.env.NODE_ENV === "production") {
      const [runtimeIdentity, migrationIdentity] = await Promise.all([
        pool.query("SELECT current_user AS role_name"),
        migrationPool.query(
          "SELECT current_user AS role_name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
        ),
      ]);
      if (
        runtimeIdentity.rows[0]?.role_name === migrationIdentity.rows[0]?.role_name ||
        migrationIdentity.rows[0]?.rolsuper ||
        migrationIdentity.rows[0]?.rolcreatedb ||
        migrationIdentity.rows[0]?.rolcreaterole
      ) {
        throw new Error(
          "Production migrations require a distinct, non-elevated schema-owner identity; the application role must remain separate.",
        );
      }
    }

    await runMigrations(migrationPool);
    if (migrationPool !== pool) {
      await migrationPool.end();
      console.log("D Hosting schema migrations completed with the dedicated migration connection.");
    }
    const runtimeRole = await pool.query(
      "SELECT current_user AS role_name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    const runtimeIdentity = runtimeRole.rows[0];
    if (
      process.env.NODE_ENV === "production" &&
      (!runtimeIdentity || runtimeIdentity.rolsuper || runtimeIdentity.rolcreatedb || runtimeIdentity.rolcreaterole)
    ) {
      throw new Error("D Hosting runtime identity must not have SUPERUSER, CREATEDB, or CREATEROLE.");
    }
    await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO d_hosting_app");
    await pool.query("REVOKE ALL ON TABLE dsquare_schema_migrations FROM d_hosting_app");
    await pool.query("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO d_hosting_app");
    await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO d_hosting_app");
    await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO d_hosting_app");
    await pool.query("SELECT 1");
    startHostingBackupScheduler(pool);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`D Hosting application running on port ${PORT}`);
      console.log("D Hosting PostgreSQL connection successful.");
      console.log("D Hosting PostgreSQL-backed website object storage enabled.");
      console.log("D Hosting optional configuration:", {
        databaseApiConfigured: Boolean(process.env.D_DATABASE_API_URL),
        databaseAppOriginConfigured: Boolean(process.env.D_DATABASE_APP_URL),
        integrationSecretConfigured: Boolean(process.env.D_HOSTING_INTEGRATION_CLIENT_SECRET),
        environmentSecretsEncryptionConfigured: Boolean(process.env.HOSTING_SECRETS_KEY),
      });
    });
  } catch (error) {
    console.error(
      "Could not start D Hosting:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

void startServer();
