import "dotenv/config";
import hostingIntegrationRouter from "./routes/hosting-integration.js";
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationPool, pool } from "./config/database.js";
import { runMigrations } from "./db/migrate.js";
import projectsRouter from "./routes/projects.js";
import databaseResourcesRouter from "./routes/database-resources.js";
import databaseTablesRouter from "./routes/database-tables.js";
import databaseStructureRouter from "./routes/database-structure.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./middleware/require-auth.js";
import { requireProjectOwnership } from "./middleware/require-project-owner.js";
import { startDatabaseBackupScheduler } from "./services/database-backup-worker.js";
import databaseBackupsRouter from "./routes/database-backups.js";
import developerApiKeysRouter from "./routes/developer-api-keys.js";
import developerDataRouter from "./routes/developer-data.js";
import { requireDeveloperKey } from "./middleware/require-developer-key.js";

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
  const configured = process.env.D_DATABASE_APP_ORIGIN?.trim();
  const value = configured || (
    process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5173"
  );

  if (!value) {
    throw new Error("D_DATABASE_APP_ORIGIN must be set in production.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("D_DATABASE_APP_ORIGIN must be a valid origin.");
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
    throw new Error("D_DATABASE_APP_ORIGIN must be a secure HTTPS origin (HTTP loopback is allowed only in development).");
  }

  return parsed.origin;
}

const APP_ORIGIN = getAllowedAppOrigin();

app.use(cors({
  origin: APP_ORIGIN,
  credentials: true,
}));
app.use(express.json());
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/integrations/hosting", hostingIntegrationRouter);
app.use("/api/v1/projects", requireAuth, projectsRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseResourcesRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseTablesRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseStructureRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseBackupsRouter);
app.use("/api/v1/projects/:projectId/resources/:resourceId/api-keys", requireAuth, requireProjectOwnership, developerApiKeysRouter);
app.use("/api/v1/data/:projectId/:resourceId", requireDeveloperKey, developerDataRouter);

app.get("/api/v1/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      product: "D Database",
      api: "online",
      database: {
        connected: true,
      },
    });
  } catch (error) {
    console.error(
      "D Database health check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    res.status(503).json({
      success: false,
      product: "D Database",
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

const PORT = Number(process.env.PORT || 5001);

async function ensureDatabaseAppDatabasePrivileges(grantPool: typeof pool): Promise<void> {
  const role = await grantPool.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_database_app') AS role_exists",
  );
  if (!role.rows[0]?.role_exists) {
    console.warn(
      "D Database role d_database_app is missing. A DBA must create the restricted runtime role before resource operations can run.",
    );
    return;
  }

  const databaseNameResult = await grantPool.query(
    "SELECT current_database() AS database_name",
  );
  const databaseName = String(databaseNameResult.rows[0]?.database_name || "").replace(/"/g, '""');
  if (!databaseName) {
    throw new Error("Could not determine the current PostgreSQL database name.");
  }

  // The migration identity grants only database connection/schema-creation
  // rights needed by D Database. It never grants CREATEROLE or grant options
  // to the application identity; role administration stays with the
  // separately configured resource provisioner.
  await grantPool.query(
    `GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO d_database_app`,
  );
  await grantPool.query("GRANT USAGE ON SCHEMA public TO d_database_app");
  console.log("D Database runtime-role database privileges are present.");
}

async function startServer() {
  try {
    if (process.env.NODE_ENV === "production" && !existsSync(clientIndexPath)) {
      throw new Error("D Database frontend build is missing. Build the client before starting the server.");
    }

    await runMigrations(migrationPool);
    await ensureDatabaseAppDatabasePrivileges(migrationPool);
    if (migrationPool !== pool) {
      await migrationPool.end();
      console.log("D Database schema migrations completed with the dedicated migration connection.");
    }
    const permissionResult = await pool.query(`
      SELECT
        current_user AS database_role,
        current_database() AS database_name,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schemas,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_database_app') AS app_role_exists,
        (SELECT owner.rolname FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_roles AS owner ON owner.oid = relation.relowner
          WHERE namespace.nspname = 'public' AND relation.relname = 'projects') AS projects_table_owner,
        (SELECT owner.rolname FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_roles AS owner ON owner.oid = relation.relowner
          WHERE namespace.nspname = 'public' AND relation.relname = 'database_resources') AS resources_table_owner,
        (SELECT owner.rolname FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_roles AS owner ON owner.oid = relation.relowner
          WHERE namespace.nspname = 'public' AND relation.relname = 'users') AS users_table_owner,
        (SELECT owner.rolname FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_roles AS owner ON owner.oid = relation.relowner
          WHERE namespace.nspname = 'public' AND relation.relname = 'user_sessions') AS sessions_table_owner,
        CASE
          WHEN current_user = 'd_database_app' THEN TRUE
          WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_database_app')
          THEN pg_has_role(current_user, 'd_database_app', 'MEMBER')
          ELSE FALSE
        END AS can_assign_app_schema_owner,
        has_table_privilege(current_user, 'public.projects', 'SELECT') AS can_read_projects,
        has_table_privilege(current_user, 'public.projects', 'INSERT') AS can_create_projects,
        has_table_privilege(current_user, 'public.projects', 'UPDATE') AS can_update_projects,
        has_table_privilege(current_user, 'public.database_resources', 'SELECT') AS can_read_resources,
        has_table_privilege(current_user, 'public.database_resources', 'INSERT') AS can_create_resources,
        has_table_privilege(current_user, 'public.database_resources', 'UPDATE') AS can_update_resources,
        has_table_privilege(current_user, 'public.users', 'SELECT') AS can_read_users,
        has_table_privilege(current_user, 'public.users', 'INSERT') AS can_create_users,
        has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_update_users,
        has_table_privilege(current_user, 'public.user_sessions', 'SELECT') AS can_read_sessions,
        has_table_privilege(current_user, 'public.user_sessions', 'INSERT') AS can_create_sessions,
        has_table_privilege(current_user, 'public.user_sessions', 'DELETE') AS can_delete_sessions
    `);
    const permissions = permissionResult.rows[0];
    console.info("D Database PostgreSQL permission preflight:", permissions);
    if (
      !permissions.can_create_schemas ||
      !permissions.app_role_exists ||
      !permissions.can_assign_app_schema_owner ||
      !permissions.can_read_projects ||
      !permissions.can_create_projects ||
      !permissions.can_update_projects ||
      !permissions.can_read_resources ||
      !permissions.can_create_resources ||
      !permissions.can_update_resources ||
      !permissions.can_read_users ||
      !permissions.can_create_users ||
      !permissions.can_update_users ||
      !permissions.can_read_sessions ||
      !permissions.can_create_sessions ||
      !permissions.can_delete_sessions
    ) {
      console.warn("D Database PostgreSQL permissions are incomplete; account or resource operations may fail.");
    }
    startDatabaseBackupScheduler(pool);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`D Database application running on port ${PORT}`);
      console.log("D Database PostgreSQL connection successful.");
    console.log("D Database optional configuration:", {
      resourceProvisionerConfigured: Boolean(process.env.DB_PROVISIONER_URL),
      runtimeHostConfigured: Boolean(process.env.D_DATABASE_RUNTIME_HOST),
      hostingIntegrationSecretConfigured: Boolean(process.env.D_HOSTING_INTEGRATION_CLIENT_SECRET),
      hostingCallbackConfigured: Boolean(process.env.D_HOSTING_CALLBACK_URL),
      accountEmailDeliveryConfigured: Boolean(
        process.env.RESEND_API_KEY && process.env.DSQUARE_ACCOUNT_EMAIL_FROM,
      ),
    });
    });
  } catch (error) {
    console.error(
      "Could not start D Database:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

void startServer();
