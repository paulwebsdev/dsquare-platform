import type { RequestHandler } from "express";

type WindowEntry = {
  count: number;
  resetAt: number;
};

export function createRateLimiter(maxRequests: number, windowMs: number): RequestHandler {
  const windows = new Map<string, WindowEntry>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let entry = windows.get(key);

    if (!entry || entry.resetAt <= now) {
      if (windows.size >= 5000) {
        for (const [storedKey, storedEntry] of windows) {
          if (storedEntry.resetAt <= now) windows.delete(storedKey);
        }
      }

      if (windows.size >= 5000) {
        res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
        return;
      }

      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
      return;
    }

    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Remaining", String(maxRequests - entry.count));
    next();
  };
}
