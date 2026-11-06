import { Router, type Request, type Response } from "express";
import { resolvePublishedDomain } from "../services/published-domain-resolver.js";
import { serveResourceFile } from "./hosting-preview.js";

const router = Router();

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function serveDomainRequest(
  req: Request,
  res: Response,
  fileName: string
) {
  try {
    // Express uses the direct Host header here because trust proxy is not enabled.
    // A future reverse proxy must sanitize Host before forwarding requests.
    const target = await resolvePublishedDomain(req.hostname);

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Website not found for this domain.",
      });
    }

    return serveResourceFile(
      req,
      res,
      target.projectId,
      target.resourceId,
      fileName,
      true
    );
  } catch (error) {
    console.error("Custom domain website resolution failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load this website.",
    });
  }
}

router.get("/", (req, res) => {
  return serveDomainRequest(req, res, "index.html");
});

router.get("/:fileName", (req, res) => {
  return serveDomainRequest(req, res, firstParam(req.params.fileName));
});

router.get(/.*/, (req, res) => {
  let filePath: string;

  try {
    filePath = decodeURIComponent(req.path.replace(/^\\//, ""));
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid website file path.",
    });
  }

  return serveDomainRequest(req, res, filePath);
});

export default router;
