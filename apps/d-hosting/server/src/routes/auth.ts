import { Router, type Request, type Response } from "express";
import {
  authenticateUser,
  createUserSession,
  deleteUserSession,
  getUserFromSession,
  registerUser,
} from "../auth/auth-service.js";

const router = Router();
const COOKIE_NAME = "dsquare_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function getSessionToken(req: Request): string | null {
  const cookies = req.headers.cookie?.split(";") ?? [];
  const entry = cookies.find((item) =>
    item.trim().startsWith(`${COOKIE_NAME}=`),
  );

  return entry ? entry.trim().slice(COOKIE_NAME.length + 1) : null;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

router.post("/register", async (req, res) => {
  try {
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      res.status(400).json({ success: false, message: "Enter a valid email address." });
      return;
    }

    if (password.length < 12 || password.length > 256) {
      res.status(400).json({
        success: false,
        message: "Password must be between 12 and 256 characters.",
      });
      return;
    }

    const user = await registerUser(email, password);
    const token = await createUserSession(user.id);

    setSessionCookie(res, token);
    res.status(201).json({ success: true, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (message.includes("already exists")) {
      res.status(409).json({ success: false, message });
      return;
    }

    console.error("Registration error:", message);
    res.status(500).json({ success: false, message: "Unable to create account." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      res.status(400).json({ success: false, message: "Email and password are required." });
      return;
    }

    const user = await authenticateUser(email, password);

    if (!user) {
      res.status(401).json({ success: false, message: "Invalid email or password." });
      return;
    }

    const token = await createUserSession(user.id);
    setSessionCookie(res, token);

    res.json({ success: true, user });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Unable to sign in." });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const token = getSessionToken(req);

    if (token) {
      await deleteUserSession(token);
    }

    clearSessionCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, message: "Unable to sign out." });
  }
});

router.get("/me", async (req, res) => {
  try {
    const token = getSessionToken(req);

    if (!token) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const user = await getUserFromSession(token);

    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ success: false, message: "Session expired or invalid." });
      return;
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error("Session lookup error:", error);
    res.status(500).json({ success: false, message: "Unable to check session." });
  }
});

export default router;
