import { useState, type FormEvent } from "react";
import { Disclaimer } from "../components/Disclaimer.tsx";
import { useAuth } from "../lib/auth.tsx";

export function LoginPage() {
  const { login, register, config, setupError } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, invite || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="brand large">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Price Action Analyst</span>
        </div>
        <p className="muted">
          Upload chart screenshots and get a structured price-action analysis: structure, liquidity, zones, FVGs, order
          blocks, and a potential setup — or a clear <strong>NO TRADE — WAIT</strong>. You make every decision; nothing is
          traded automatically.
        </p>
        {setupError && <div className="alert error small">{setupError}</div>}
        <form onSubmit={submit} className="stack">
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "register" && <span className="tiny muted">At least 10 characters.</span>}
          </label>
          {mode === "register" && config?.inviteRequired && (
            <label>
              Invite code
              <input required value={invite} onChange={(e) => setInvite(e.target.value)} />
            </label>
          )}
          {error && <div className="alert error">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        {config?.registrationEnabled !== false && (
          <button className="btn link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "No account? Create one" : "Have an account? Sign in"}
          </button>
        )}
        <Disclaimer compact />
      </div>
    </div>
  );
}
