import type { Request, Response, NextFunction } from "express";
import { getUserFromSession } from "../auth/auth-service.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cookies = req.headers.cookie?.split(";") ?? [];
    const entry = cookies.find(
      (item) => item.trim().startsWith("dsquare_session="),
    );

    const token = entry
      ? entry.trim().slice("dsquare_session=".length)
      : null;

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
      return;
    }

    const user = await getUserFromSession(token);

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Session expired or invalid.",
      });
      return;
    }

    res.locals.userId = user.id;
    res.locals.user = user;

    next();
  } catch (error) {
    console.error("Authentication middleware error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to verify authentication.",
    });
  }
}
