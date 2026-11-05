import { useState, type FormEvent } from "react";

export type AuthUser = {
  id: string;
  email: string;
};

type Props = {
  onAuthenticated: (user: AuthUser) => void;
};

export default function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`/api/v1/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok || !data.success || !data.user) {
        throw new Error(data.message || "Authentication failed.");
      }

      onAuthenticated(data.user as AuthUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span>D</span> DSQUARE<span className="brand-dot">.</span></div>
        <div className="auth-eyebrow">DSQUARE HOSTING</div>
        <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="auth-description">
          {mode === "login"
            ? "Sign in to manage your websites and projects."
            : "Create an account to get started with your hosting workspace."}
        </p>

        <label htmlFor="auth-email">Email address</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />

        <label htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "register" ? 12 : undefined}
          maxLength={256}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={mode === "register" ? "At least 12 characters" : "Your password"}
        />

        {error && <div className="auth-error" role="alert">{error}</div>}

        <button className="auth-submit" type="submit" disabled={loading}>
          {loading ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <div className="auth-switch">
          {mode === "login" ? "Don't have an account?" : "Already have an account?"}
          {" "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "Create account" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}
