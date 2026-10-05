import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { WATCH_STATUS_LABELS, type WatchlistItem, type WatchStatus } from "../../shared/types.ts";
import { DecisionBadge, GradeBadge, WatchBadge } from "../components/Badges.tsx";
import { api } from "../lib/api.ts";
import { fmtDate } from "../lib/format.ts";
import { useLoader } from "../lib/hooks.ts";

function Row({ item, onChange }: { item: WatchlistItem; onChange: () => void }) {
  const [pv, setPv] = useState(item.pointValue?.toString() ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const patch = async (body: Record<string, unknown>) => {
    await api.patch(`/watchlist/${item.id}`, body);
    onChange();
  };
  return (
    <tr>
      <td>
        <strong>{item.symbol}</strong>
      </td>
      <td>
        <WatchBadge status={item.effectiveStatus} />
        {item.statusOverride && <span className="tiny muted"> (manual)</span>}
      </td>
      <td>
        {item.latest ? (
          <Link to={`/analysis/${item.latest.analysisId}`} className="row gap-s">
            <DecisionBadge decision={item.latest.finalDecision} /> <GradeBadge grade={item.latest.grade} />
            <span className="tiny muted">{fmtDate(item.latest.createdAt)}</span>
          </Link>
        ) : (
          <span className="small muted">Not analysed yet</span>
        )}
      </td>
      <td>
        <select
          value={item.statusOverride ?? ""}
          onChange={(e) => void patch({ statusOverride: (e.target.value || null) as WatchStatus | null })}
          aria-label="Status override"
        >
          <option value="">Auto (from latest analysis)</option>
          {Object.entries(WATCH_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="narrow"
          inputMode="decimal"
          value={pv}
          placeholder="e.g. 10"
          onChange={(e) => setPv(e.target.value)}
          onBlur={() => pv !== (item.pointValue?.toString() ?? "") && void patch({ pointValue: pv.trim() ? Number(pv) : null })}
          title="Account-currency value of a 1.0 price move for one unit/lot/contract. Needed for position sizing."
        />
      </td>
      <td>
        <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (item.notes ?? "") && void patch({ notes: notes || null })} />
      </td>
      <td>
        <button
          className="btn link small danger"
          onClick={async () => {
            if (confirm(`Remove ${item.symbol} from the watchlist?`)) {
              await api.del(`/watchlist/${item.id}`);
              onChange();
            }
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

export function WatchlistPage() {
  const { data, reload, error } = useLoader(() => api.get<{ items: WatchlistItem[] }>("/watchlist").then((r) => r.items));
  const [symbol, setSymbol] = useState("");
  const [pointValue, setPointValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api.post("/watchlist", { symbol, pointValue: pointValue.trim() ? Number(pointValue) : null });
      setSymbol("");
      setPointValue("");
      void reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack">
      <h1>Watchlist</h1>
      <p className="muted small">
        Status comes from each symbol's most recent analysis: <strong>Strong Setup</strong> (A/A+ potential trade, entry ready), <strong>Developing Setup</strong>{" "}
        (potential trade needing confirmation or grade B), <strong>Watch</strong> (directional context but no valid trade yet), <strong>No Setup</strong>. Upload a
        fresh screenshot to update it. Nothing is ever traded automatically.
      </p>
      <form className="card row gap-s wrap" onSubmit={add}>
        <label>
          Symbol
          <input required value={symbol} maxLength={32} onChange={(e) => setSymbol(e.target.value)} placeholder="EURUSD, XAUUSD, NAS100…" />
        </label>
        <label>
          Value of 1.0 price move per unit (optional)
          <input inputMode="decimal" value={pointValue} onChange={(e) => setPointValue(e.target.value)} placeholder="for position sizing" />
        </label>
        <button className="btn primary">Add</button>
        {msg && <span className="error-text small">{msg}</span>}
      </form>
      {error && <div className="alert error">{error}</div>}
      <section className="card table-wrap">
        {data && data.length === 0 ? (
          <p className="muted small">Your watchlist is empty.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Status</th>
                <th>Latest analysis</th>
                <th>Override</th>
                <th>Value / 1.0 move</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>{data?.map((w) => <Row key={w.id} item={w} onChange={() => void reload()} />)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
