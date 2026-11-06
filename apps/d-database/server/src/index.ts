import hostingIntegrationRouter from "./routes/hosting-integration.js";
import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool } from "./config/database.js";
import projectsRouter from "./routes/projects.js";
import databaseResourcesRouter from "./routes/database-resources.js";
import databaseTablesRouter from "./routes/database-tables.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./middleware/require-auth.js";
import { requireProjectOwnership } from "./middleware/require-project-owner.js";

const app = express();

app.use(cors({ origin: ["http://127.0.0.1:5173"], credentials: true }));
app.use(express.json());
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/integrations/hosting", hostingIntegrationRouter);
app.use("/api/v1/projects", requireAuth, projectsRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseResourcesRouter);
app.use("/api/v1/projects/:projectId/resources", requireAuth, requireProjectOwnership, databaseTablesRouter);

app.get("/api/v1/health", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database, current_user AS username"
    );

    res.json({
      success: true,
      product: "D Database",
      api: "online",
      database: {
        connected: true,
        name: result.rows[0].database,
        user: result.rows[0].username,
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

const PORT = 5001;

async function startServer() {
  try {
    await pool.query("SELECT 1");

    app.listen(PORT, "127.0.0.1", () => {
      console.log(`D Database API running at http://127.0.0.1:${PORT}`);
      console.log("D Database PostgreSQL connection successful.");
    });
  } catch (error) {
    console.error(
      "Could not connect to D Database:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

void startServer();