import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_SETTINGS, type UserSettings } from "../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";

const num = (v: string) => (v.trim() === "" ? null : Number(v));

function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function SettingsPage() {
  const { config } = useAuth();
  const [s, setS] = useState<UserSettings | null>(null);
  const [balance, setBalance] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [browserNotif, setBrowserNotif] = useState(readPref("paa.browserNotifications") === "1");

  useEffect(() => {
    api.get<{ settings: UserSettings }>("/settings").then(({ settings }) => {
      setS(settings);
      setBalance(settings.accountBalance?.toString() ?? "");
    });
  }, []);
  if (!s) return <p className="muted">Loading…</p>;

  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => setS({ ...s, [k]: v });
  const setAlert = <K extends keyof UserSettings["alerts"]>(k: K, v: UserSettings["alerts"][K]) => setS({ ...s, alerts: { ...s.alerts, [k]: v } });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { settings } = await api.put<{ settings: UserSettings }>("/settings", { ...s, accountBalance: num(balance) });
      setS(settings);
      setMsg({ ok: true, text: "Settings saved." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const toggleBrowser = async (on: boolean) => {
    if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        setMsg({ ok: false, text: "Browser notifications were blocked. Allow them in your browser's site settings." });
        return;
      }
    }
    writePref("paa.browserNotifications", on ? "1" : "0");
    setBrowserNotif(on);
    setAlert("browserNotifications", on);
  };

  return (
    <form className="stack settings" onSubmit={save}>
      <h1>Settings</h1>

      <section className="card stack">
        <h3>Money management</h3>
        <p className="small muted">
          Recommended: risk approximately <strong>0.5%–1%</strong> of your account per trade. The app calculates position size only when your balance, risk % and the
          instrument's value per 1.0 price move (set on the watchlist) are known — it never guesses contract specifications.
        </p>
        <div className="grid-3">
          <label>
            Account balance
            <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="optional" />
          </label>
          <label>
            Currency
            <input value={s.accountCurrency} maxLength={5} onChange={(e) => set("accountCurrency", e.target.value.toUpperCase())} />
          </label>
          <label>
            Risk per trade (%)
            <input type="number" step="any" min="0.01" max="5" value={s.riskPercent} onChange={(e) => set("riskPercent", Number(e.target.value))} />
            {s.riskPercent > 1 && <span className="tiny warn-text">Above the recommended 0.5%–1%.</span>}
          </label>
          <label>
            Maximum daily loss (%)
            <input type="number" step="any" min="0.1" max="20" value={s.maxDailyLossPercent} onChange={(e) => set("maxDailyLossPercent", Number(e.target.value))} />
          </label>
          <label>
            Maximum trades per day
            <input type="number" min="1" max="50" value={s.maxTradesPerDay} onChange={(e) => set("maxTradesPerDay", Number(e.target.value))} />
          </label>
          <label>
            Minimum R:R (1:x)
            <input type="number" step="any" min="0.5" max="20" value={s.minRr} onChange={(e) => set("minRr", Number(e.target.value))} />
          </label>
          <label>
            Minimum setup grade
            <select value={s.minGrade} onChange={(e) => set("minGrade", e.target.value as UserSettings["minGrade"])}>
              {["A+", "A", "B", "C"].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="tiny muted">Setups below your minimum R:R or grade are shown for reference but marked NO TRADE — WAIT. Changes apply to new analyses.</p>
      </section>

      <section className="card stack">
        <h3>Alerts (optional)</h3>
        <p className="small muted">
          Alerts are checked each time a new screenshot is analysed (the app has no live price feed). They appear under the bell icon, and optionally as browser
          notifications while the app is open.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={s.alerts.enabled} onChange={(e) => setAlert("enabled", e.target.checked)} /> Enable alerts
        </label>
        <fieldset disabled={!s.alerts.enabled} className="stack">
          <label className="toggle">
            <input type="checkbox" checked={s.alerts.aSetup} onChange={(e) => setAlert("aSetup", e.target.checked)} /> Potential A / A+ setup
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.alerts.approachingLevel} onChange={(e) => setAlert("approachingLevel", e.target.checked)} /> Price approaching an important
            level, within
            <input
              className="inline-input"
              type="number"
              step="any"
              min="0.01"
              max="5"
              value={s.alerts.approachingThresholdPercent}
              onChange={(e) => setAlert("approachingThresholdPercent", Number(e.target.value))}
            />
            %
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.alerts.liquiditySweep} onChange={(e) => setAlert("liquiditySweep", e.target.checked)} /> Liquidity sweep detected
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.alerts.breakoutRetest} onChange={(e) => setAlert("breakoutRetest", e.target.checked)} /> Breakout / retest developing
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.alerts.setupInvalidated} onChange={(e) => setAlert("setupInvalidated", e.target.checked)} /> Earlier setup invalidated
          </label>
          <label className="toggle">
            <input type="checkbox" checked={browserNotif} onChange={(e) => void toggleBrowser(e.target.checked)} /> Browser notifications on this device
          </label>
        </fieldset>
      </section>

      <section className="card stack">
        <h3>About this app</h3>
        <ul className="small">
          <li>
            AI model: {config?.model ?? "—"}
            {config?.aiProvider === "gemini" && config.pricing.input === 0 ? " (Google Gemini free tier — no cost, limited requests per minute/day)" : ""}
            {config?.pricing && config.aiProvider === "anthropic" ? ` (≈ $${config.pricing.input}/$${config.pricing.output} per million input/output tokens)` : ""}.
          </li>
          <li>Price action only — no indicators. No automated trading, no broker connection.</li>
          <li>Confidence levels describe evidence quality, never a probability of profit.</li>
        </ul>
        <button type="button" className="btn small ghost self-start" onClick={() => (setS({ ...DEFAULT_SETTINGS, alerts: s.alerts }), setBalance(""))}>
          Reset money-management defaults
        </button>
      </section>

      <div className="row gap-s sticky-save">
        <button className="btn primary">Save settings</button>
        {msg && <span className={msg.ok ? "small" : "small error-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}
