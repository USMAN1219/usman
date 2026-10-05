import { useState } from "react";
import type { AnalysisSummary } from "../../shared/types.ts";
import { AnalysisList } from "../components/AnalysisList.tsx";
import { api } from "../lib/api.ts";
import { useLoader } from "../lib/hooks.ts";

const PAGE = 25;

export function HistoryPage() {
  const [symbol, setSymbol] = useState("");
  const [direction, setDirection] = useState("");
  const [grade, setGrade] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useLoader(() => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (symbol.trim()) q.set("symbol", symbol.trim());
    if (direction) q.set("direction", direction);
    if (grade) q.set("grade", grade);
    return api.get<{ items: AnalysisSummary[]; total: number }>(`/analyses?${q}`);
  }, [symbol, direction, grade, offset]);

  return (
    <div className="stack">
      <h1>Analysis history</h1>
      <div className="card filters">
        <label>
          Symbol
          <input value={symbol} onChange={(e) => (setSymbol(e.target.value), setOffset(0))} placeholder="Any" />
        </label>
        <label>
          Direction
          <select value={direction} onChange={(e) => (setDirection(e.target.value), setOffset(0))}>
            <option value="">Any</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
            <option value="no_trade">No trade</option>
          </select>
        </label>
        <label>
          Grade
          <select value={grade} onChange={(e) => (setGrade(e.target.value), setOffset(0))}>
            <option value="">Any</option>
            {["A+", "A", "B", "C", "no_trade"].map((g) => (
              <option key={g} value={g}>
                {g === "no_trade" ? "No trade" : g}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="alert error">{error}</div>}
      <section className="card">
        {loading && !data ? <p className="muted">Loading…</p> : <AnalysisList items={data?.items ?? []} empty="No analyses match these filters." />}
        {data && data.total > PAGE && (
          <div className="row between">
            <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Newer
            </button>
            <span className="small muted">
              {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
            </span>
            <button className="btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
              Older →
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
