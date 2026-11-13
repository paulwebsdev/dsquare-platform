import { Router } from "express";
import { pool } from "../config/database.js";
import { requireDeveloperScope } from "../middleware/require-developer-key.js";
import {
  executeDeveloperTransaction,
  DeveloperTransactionValidationError,
} from "../services/developer-transaction.js";

const router = Router({ mergeParams: true });

// Run a bounded group of writes atomically inside the API key's one resource schema.
router.post("/transactions", requireDeveloperScope("write"), async (req, res) => {
  const key = res.locals.developerKey as { schema_name: string };
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const results = await executeDeveloperTransaction(client, key.schema_name, req.body?.operations);
    await client.query("COMMIT");
    transactionStarted = false;
    return res.json({ success: true, committed: true, operationCount: results.length, results });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof DeveloperTransactionValidationError) {
      return res.status(400).json({ success: false, committed: false, message: error.message });
    }
    const code = (error as { code?: string })?.code;
    if (["23505", "23503", "23502", "23514", "235 Check"].includes(String(code))) {
      return res.status(409).json({ success: false, committed: false, message: "The transaction conflicts with a database constraint; no operations were committed." });
    }
    console.error("Developer transaction failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, committed: false, message: "The transaction failed; no operations were committed." });
  } finally {
    client.release();
  }
});

export default router;
