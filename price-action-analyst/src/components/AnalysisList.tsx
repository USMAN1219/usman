import { Link } from "react-router-dom";
import type { AnalysisSummary } from "../../shared/types.ts";
import { fmtDate, fmtPrice, fmtRange, fmtRr, fmtUsd } from "../lib/format.ts";
import { DecisionBadge, GradeBadge } from "./Badges.tsx";

export function AnalysisList({ items, empty = "No analyses yet." }: { items: AnalysisSummary[]; empty?: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Symbol</th>
            <th>Timeframes</th>
            <th>Decision</th>
            <th>Grade</th>
            <th>Entry</th>
            <th>SL</th>
            <th>TP1 / TP2</th>
            <th>R:R</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to={`/analysis/${a.id}`}>{fmtDate(a.createdAt)}</Link>
                {a.taken && <span className="tag">taken{a.outcomePnl != null ? ` ${a.outcomePnl > 0 ? "+" : ""}${a.outcomePnl}` : ""}</span>}
              </td>
              <td>{a.symbol ?? "—"}</td>
              <td className="small">{a.timeframes.join(" · ") || "—"}</td>
              <td>
                {a.status === "completed" ? (
                  <DecisionBadge decision={a.finalDecision} />
                ) : (
                  <span className={`badge status-${a.status}`}>{a.status}</span>
                )}
              </td>
              <td>
                <GradeBadge grade={a.grade} />
              </td>
              <td>{a.direction && a.direction !== "no_trade" ? fmtRange(a.entryLow, a.entryHigh) : "—"}</td>
              <td>{a.direction && a.direction !== "no_trade" ? fmtPrice(a.stopLoss) : "—"}</td>
              <td>{a.direction && a.direction !== "no_trade" ? `${fmtPrice(a.tp1)} / ${fmtPrice(a.tp2)}` : "—"}</td>
              <td>{fmtRr(a.rr)}</td>
              <td className="small muted">{fmtUsd(a.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
