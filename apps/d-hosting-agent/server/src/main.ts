import "dotenv/config";
import { startRuntimeAgent } from "./index.js";

void startRuntimeAgent().catch((error: unknown) => {
  console.error("Could not start D Hosting Runtime Agent:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
