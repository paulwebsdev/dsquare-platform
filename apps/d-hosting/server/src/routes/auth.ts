import { Router, type Request, type Response } from "express";
import {
  authenticateUser,
  changeUserPassword,
  createPasswordResetToken,
  resetUserPassword,
  revokePasswordResetToken,
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


async function sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.DSQUARE_ACCOUNT_EMAIL_FROM?.trim();
  const origin = process.env.D_HOSTING_APP_ORIGIN?.trim();
  if (!apiKey || !from || !origin) return false;

  let appUrl: URL;
  try {
    appUrl = new URL(origin);
  } catch {
    return false;
  }
  if (appUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && appUrl.hostname === "127.0.0.1")) {
    return false;
  }

  const resetUrl = new URL("/", appUrl);
  resetUrl.searchParams.set("passwordResetToken", token);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Reset your D Hosting password",
      text: `We received a request to reset your D Hosting password. Open this link within 30 minutes: ${resetUrl.toString()} If you did not request this, ignore this email.`,
      html: `<p>We received a request to reset your D Hosting password.</p><p><a href="${resetUrl.toString()}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`,
    }),
  });
  return response.ok;
}

router.post("/password/change", async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (!token) {
      res.status(401).json({ success: false, message: "Please sign in again." });
      return;
    }
    const user = await getUserFromSession(token);
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
      return;
    }
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (newPassword.length < 12 || newPassword.length > 256) {
      res.status(400).json({ success: false, message: "New password must be between 12 and 256 characters." });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, message: "Choose a password different from your current password." });
      return;
    }
    const changed = await changeUserPassword(user.id, currentPassword, newPassword);
    if (!changed) {
      res.status(400).json({ success: false, message: "Your current password is incorrect." });
      return;
    }
    const replacementSession = await createUserSession(user.id);
    setSessionCookie(res, replacementSession);
    res.json({ success: true, message: "Password updated. Other active sessions have been signed out." });
  } catch (error) {
    console.error("Password change error:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ success: false, message: "Unable to update your password." });
  }
});

router.post("/password-reset/request", async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.DSQUARE_ACCOUNT_EMAIL_FROM?.trim();
  const origin = process.env.D_HOSTING_APP_ORIGIN?.trim();
  if (!apiKey || !from || !origin) {
    res.status(503).json({ success: false, message: "Password reset email is not configured yet. Please contact support." });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 254) {
    res.status(400).json({ success: false, message: "Enter a valid email address." });
    return;
  }
  try {
    const resetToken = await createPasswordResetToken(email);
    if (resetToken) {
      const sent = await sendPasswordResetEmail(email, resetToken);
      if (!sent) {
        await revokePasswordResetToken(resetToken);
        res.status(503).json({ success: false, message: "We could not send the reset email. Please try again later." });
        return;
      }
    }
    res.json({ success: true, message: "If an account exists for that email, a password reset link has been sent." });
  } catch (error) {
    console.error("Password reset request error:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ success: false, message: "Unable to process the password reset request." });
  }
});

router.post("/password-reset/complete", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  if (newPassword.length < 12 || newPassword.length > 256) {
    res.status(400).json({ success: false, message: "Password must be between 12 and 256 characters." });
    return;
  }
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    res.status(400).json({ success: false, message: "This reset link is invalid or has expired. Request a new one." });
    return;
  }
  try {
    const reset = await resetUserPassword(token, newPassword);
    if (!reset) {
      res.status(400).json({ success: false, message: "This reset link is invalid or has expired. Request a new one." });
      return;
    }
    clearSessionCookie(res);
    res.json({ success: true, message: "Password reset successfully. Please sign in with your new password." });
  } catch (error) {
    console.error("Password reset completion error:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ success: false, message: "Unable to reset your password." });
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
