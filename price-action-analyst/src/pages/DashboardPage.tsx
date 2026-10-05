import { Link } from "react-router-dom";
import type { AnalysisSummary, DailyRiskStatus, UsageSummary, UserSettings, WatchlistItem } from "../../shared/types.ts";
import { AnalysisList } from "../components/AnalysisList.tsx";
import { DecisionBadge, GradeBadge, WatchBadge } from "../components/Badges.tsx";
import { UploadPanel } from "../components/UploadPanel.tsx";
import { api } from "../lib/api.ts";
import { fmtMoney, fmtUsd, localMidnightIso } from "../lib/format.ts";
import { useLoader } from "../lib/hooks.ts";

function RiskStatus() {
  const { data } = useLoader(async () => {
    const [risk, settings] = await Promise.all([
      api.get<{ status: DailyRiskStatus }>(`/risk/today?since=${encodeURIComponent(localMidnightIso())}`),
      api.get<{ settings: UserSettings }>("/settings"),
    ]);
    return { risk: risk.status, settings: settings.settings };
  });
  if (!data) return null;
  const { risk, settings } = data;
  const limit = risk.tradeLimitReached || risk.lossLimitReached;
  return (
    <section className={`card risk ${limit ? "limit" : ""}`}>
      <h3>Today's risk</h3>
      <div className="kv-grid">
        <div className="kv">
          <span className="k">Trades taken</span>
          <span className="v">
            {risk.tradesTaken} / {risk.maxTrades}
          </span>
        </div>
        <div className="kv">
          <span className="k">Realised P&L</span>
          <span className="v">{fmtMoney(risk.realisedPnl, settings.accountCurrency)}</span>
        </div>
        <div className="kv">
          <span className="k">Max daily loss</span>
          <span className="v">{risk.maxDailyLoss != null ? fmtMoney(risk.maxDailyLoss, settings.accountCurrency) : "Set balance in Settings"}</span>
        </div>
        <div className="kv">
          <span className="k">Risk per trade</span>
          <span className="v">{settings.riskPercent}%</span>
        </div>
      </div>
      {limit && (
        <p className="alert warn small">
          {risk.lossLimitReached ? "Daily loss limit reached." : "Maximum trades for today reached."} Consider stopping for today — protecting capital matters more than
          the next setup.
        </p>
      )}
    </section>
  );
}

function SetupStatus() {
  const { data } = useLoader(() => api.get<{ items: WatchlistItem[] }>("/watchlist").then((r) => r.items));
  const relevant = (data ?? []).filter((w) => w.effectiveStatus === "strong_setup" || w.effectiveStatus === "developing_setup");
  return (
    <section className="card">
      <div className="row between">
        <h3>Setup status</h3>
        <Link to="/watchlist" className="small">
          Watchlist →
        </Link>
      </div>
      {!data?.length && <p className="small muted">Add instruments to your watchlist to track which charts deserve attention.</p>}
      {data && data.length > 0 && relevant.length === 0 && <p className="small muted">No strong or developing setups on your watchlist right now.</p>}
      <ul className="items">
        {relevant.map((w) => (
          <li key={w.id} className="row between">
            <span>
              <strong>{w.symbol}</strong> <WatchBadge status={w.effectiveStatus} />
            </span>
            {w.latest && (
              <Link to={`/analysis/${w.latest.analysisId}`} className="row gap-s">
                <DecisionBadge decision={w.latest.finalDecision} /> <GradeBadge grade={w.latest.grade} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Usage() {
  const { data } = useLoader(() => api.get<{ usage: UsageSummary }>("/usage").then((r) => r.usage));
  if (!data) return null;
  return (
    <section className="card">
      <h3>AI usage this month</h3>
      <p className="small">
        {data.analysesThisMonth} analyses · approx. <strong>{fmtUsd(data.costThisMonthUsd)}</strong>
      </p>
      <p className="tiny muted">
        Limits: {data.limits.perHour}/hour, {data.limits.perDay}/day{data.limits.monthlyBudgetUsd ? `, app budget ${fmtUsd(data.limits.monthlyBudgetUsd)}/month` : ""}. Costs
        are estimates from token usage.
      </p>
    </section>
  );
}

export function DashboardPage() {
  const recent = useLoader(() => api.get<{ items: AnalysisSummary[] }>("/analyses?limit=8").then((r) => r.items));
  const latest = recent.data?.find((a) => a.status === "completed");
  return (
    <div className="dashboard">
      <div className="stack">
        <UploadPanel onSubmitted={() => void recent.reload()} />
        {latest && (
          <section className="card current">
            <div className="row between wrap">
              <h3>Current analysis</h3>
              <Link to={`/analysis/${latest.id}`}>Open →</Link>
            </div>
            <div className="row gap-s wrap">
              <strong>{latest.symbol ?? "Chart"}</strong> <DecisionBadge decision={latest.finalDecision} /> <GradeBadge grade={latest.grade} />
            </div>
          </section>
        )}
        <section className="card">
          <div className="row between">
            <h3>Recent analyses</h3>
            <Link to="/history" className="small">
              All history →
            </Link>
          </div>
          <AnalysisList items={recent.data ?? []} empty="Upload your first chart screenshots above." />
        </section>
      </div>
      <aside className="stack">
        <RiskStatus />
        <SetupStatus />
        <Usage />
      </aside>
    </div>
  );
}
