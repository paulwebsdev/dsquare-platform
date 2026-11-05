import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool } from "./config/database.js";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import hostingResourcesRouter from "./routes/hosting-resources.js";
import hostingFilesRouter from "./routes/hosting-files.js";
import hostingPreviewRouter from "./routes/hosting-preview.js";

const app = express();

app.use(cors({
  origin: ["http://127.0.0.1:5174"],
  credentials: true,
}));

app.use(express.json());

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/projects", projectsRouter);
app.use("/api/v1/projects/:projectId/resources", hostingResourcesRouter);
app.use("/api/v1/projects/:projectId/resources", hostingFilesRouter);
app.use("/api/v1/projects/:projectId/resources", hostingPreviewRouter);

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
        user: result.rows[0].username,
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
