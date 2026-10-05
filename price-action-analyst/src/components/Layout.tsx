import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { AppNotification } from "../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { fmtDate } from "../lib/format.ts";
import { useInterval } from "../lib/hooks.ts";
import { Disclaimer } from "./Disclaimer.tsx";

function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const seen = useRef(new Set<string>());
  const initialised = useRef(false);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const { items } = await api.get<{ items: AppNotification[] }>("/notifications?unread=1");
      // Browser notifications only for alerts we have not shown before, and only if the user opted in.
      const allowed =
        typeof Notification !== "undefined" && Notification.permission === "granted" && readPref("paa.browserNotifications") === "1";
      if (initialised.current && allowed) {
        for (const n of items) if (!seen.current.has(n.id)) new Notification(n.title, { body: n.body });
      }
      items.forEach((n) => seen.current.add(n.id));
      initialised.current = true;
      setItems(items);
    } catch {
      /* non-critical */
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useInterval(load, 60_000);

  const markAll = async () => {
    await api.post("/notifications/read", { ids: "all" });
    setItems([]);
    setOpen(false);
  };

  return (
    <div className="bell">
      <button className="btn ghost" onClick={() => setOpen((o) => !o)} aria-label={`Alerts (${items.length} unread)`}>
        🔔{items.length > 0 && <span className="bell-count">{items.length}</span>}
      </button>
      {open && (
        <div className="bell-menu card">
          <div className="row between">
            <strong>Alerts</strong>
            {items.length > 0 && (
              <button className="btn link" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 && <p className="muted small">No unread alerts. Enable alerts in Settings.</p>}
          {items.map((n) => (
            <button
              key={n.id}
              className="bell-item"
              onClick={() => {
                setOpen(false);
                void api.post("/notifications/read", { ids: [n.id] }).then(load);
                if (n.analysisId) navigate(`/analysis/${n.analysisId}`);
              }}
            >
              <strong>{n.title}</strong>
              <span className="small muted">{n.body}</span>
              <span className="tiny muted">{fmtDate(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, config } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Price Action Analyst</span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/watchlist">Watchlist</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="row gap-s">
          <NotificationBell />
          <span className="muted small hide-sm">{user?.email}</span>
          <button className="btn ghost small" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      {config?.aiProvider === "mock" && (
        <div className="banner warn">MOCK AI MODE — results are fake test data. Never use them for trading.</div>
      )}
      <main className="main">{children}</main>
      <footer className="footer">
        <Disclaimer />
        <p className="tiny muted">Analysis assistant only. This app never places trades and is not financial advice.</p>
      </footer>
    </div>
  );
}
