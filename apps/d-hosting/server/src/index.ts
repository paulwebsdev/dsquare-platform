import "dotenv/config";
import databaseConnectionsRouter from "./routes/database-connections.js";
import express from "express";
import cors from "cors";
import { pool } from "./config/database.js";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import hostingResourcesRouter from "./routes/hosting-resources.js";
import hostingFilesRouter from "./routes/hosting-files.js";
import hostingDeploymentsRouter from "./routes/hosting-deployments.js";
import hostingPreviewRouter from "./routes/hosting-preview.js";
import hostingDomainsRouter from "./routes/hosting-domains.js";
import hostingDomainSiteRouter from "./routes/hosting-domain-site.js";

const app = express();

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
app.use("/api/v1/projects/:projectId/resources", hostingFilesRouter);
app.use("/api/v1/projects/:projectId/resources", hostingDeploymentsRouter);

// Project routes have global authentication and must follow the public website routes.
app.use("/api/v1/projects", projectsRouter);

app.get("/api/v1/health", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database, current_user AS username"
    );

    res.json({
      success: true,
      product: "D Hosting",
      api: "online",
      database: {
        connected: true,
        name: result.rows[0].database,
        username: result.rows[0].username,
      },
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

const PORT = 5002;

async function startServer() {
  try {
    await pool.query("SELECT 1");

    app.listen(PORT, "127.0.0.1", () => {
      console.log(`D Hosting API running at http://127.0.0.1:${PORT}`);
      console.log("D Hosting PostgreSQL connection successful.");
    });
  } catch (error) {
    console.error(
      "Could not connect to D Hosting:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

void startServer();
