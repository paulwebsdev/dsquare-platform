import { useState, type FormEvent } from "react";

export type AuthUser = {
  id: string;
  email: string;
};

type Props = {
  onAuthenticated: (user: AuthUser) => void;
};

type AuthMode = "login" | "register" | "forgot" | "reset";

export default function AuthScreen({ onAuthenticated }: Props) {
  const resetToken = useState(() => {\n    const token = new URLSearchParams(window.location.search).get("passwordResetToken") || "";\n    if (token) window.history.replaceState({}, "", window.location.pathname);\n    return token;\n  })[0];
  const [mode, setMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (mode === "reset" && password !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const endpoint = mode === "forgot"
        ? "/api/v1/auth/password-reset/request"
        : mode === "reset"
          ? "/api/v1/auth/password-reset/complete"
          : `/api/v1/auth/${mode === "login" ? "login" : "register"}`;
      const body = mode === "forgot"
        ? { email }
        : mode === "reset"
          ? { token: resetToken, newPassword: password }
          : { email, password };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Your request could not be completed.");
      }
      if (mode === "login" || mode === "register") {
        if (!data.user) throw new Error("Authentication response was incomplete.");
        onAuthenticated(data.user as AuthUser);
      } else if (mode === "forgot") {
        setMessage(data.message || "If an account exists for that email, a reset link has been sent.");
      } else {
        setMessage(data.message || "Password reset successfully. Please sign in.");
        window.history.replaceState({}, "", window.location.pathname);
        setPassword("");
        setConfirmPassword("");
        setMode("login");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const title = mode === "login" ? "Welcome back"
    : mode === "register" ? "Create your account"
      : mode === "forgot" ? "Reset your password" : "Choose a new password";

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span>D</span> DSQUARE<span className="brand-dot">.</span></div>
        <div className="auth-eyebrow">DSQUARE HOSTING</div>
        <h1>{title}</h1>
        <p className="auth-description">
          {mode === "login" ? "Sign in to manage your workspace."
            : mode === "register" ? "Create an account to get started with your hosting workspace."
              : mode === "forgot" ? "Enter your account email and we will send a secure password reset link."
                : "Your reset link is valid for 30 minutes. Choose a password you have not used before."}
        </p>

        <label htmlFor="auth-email">Email address</label>
        <input id="auth-email" type="email" autoComplete="email" required maxLength={254}
          value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com"
          disabled={mode === "reset"} />

        {(mode === "login" || mode === "register" || mode === "reset") && <>
          <label htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}</label>
          <input id="auth-password" type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "login" ? undefined : 12} maxLength={256} required
            value={password} onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === "login" ? "Your password" : "At least 12 characters"} />
        </>}

        {mode === "reset" && <>
          <label htmlFor="auth-confirm-password">Confirm new password</label>
          <input id="auth-confirm-password" type="password" autoComplete="new-password"
            minLength={12} maxLength={256} required value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter the new password again" />
        </>}

        {error && <div className="auth-error" role="alert">{error}</div>}
        {message && <div className="auth-message" role="status">{message}</div>}

        <button className="auth-submit" type="submit" disabled={loading || (mode === "reset" && !resetToken)}>
          {loading ? "Please wait..." : mode === "login" ? "Sign in"
            : mode === "register" ? "Create account"
              : mode === "forgot" ? "Send reset link" : "Reset password"}
        </button>

        {mode === "login" && <div className="auth-switch">
          <button type="button" onClick={() => { setMode("forgot"); setError(""); setMessage(""); }}>Forgot password?</button>
        </div>}
        {mode === "forgot" && <div className="auth-switch">
          <button type="button" onClick={() => { setMode("login"); setError(""); setMessage(""); }}>Back to sign in</button>
        </div>}
        {mode === "reset" && !resetToken && <div className="auth-error" role="alert">This reset link is missing or invalid. Request a new one.</div>}
        {(mode === "login" || mode === "register") && <div className="auth-switch">
          {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
          <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setMessage(""); }}>
            {mode === "login" ? "Create account" : "Sign in"}
          </button>
        </div>}
      </form>
    </main>
  );
}
