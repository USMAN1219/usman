import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AnalysisRecord } from "../../shared/types.ts";
import { AnalysisReport } from "../components/AnalysisReport.tsx";
import { ChartAnnotator } from "../components/ChartAnnotator.tsx";
import { api, imageUrl } from "../lib/api.ts";
import { fmtDate, fmtUsd } from "../lib/format.ts";
import { useInterval, useLoader } from "../lib/hooks.ts";

function Progress({ record }: { record: AnalysisRecord }) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(record.createdAt)) / 1000));
  return (
    <div className="card progress">
      <div className="spinner" aria-hidden />
      <div>
        <strong>{record.status === "queued" ? "Queued…" : "Analysing charts…"}</strong>
        <p className="small muted">
          Reading structure, liquidity, zones and timeframes. A thorough multi-timeframe analysis usually takes 1–3 minutes ({seconds}s so far). You can leave
          this page; the result is saved to your history.
        </p>
      </div>
    </div>
  );
}

function OutcomeForm({ record, onSaved }: { record: AnalysisRecord; onSaved: (r: AnalysisRecord) => void }) {
  const [taken, setTaken] = useState(record.taken);
  const [pnl, setPnl] = useState(record.outcomePnl?.toString() ?? "");
  const [note, setNote] = useState(record.outcomeNote ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    try {
      const { analysis } = await api.patch<{ analysis: AnalysisRecord }>(`/analyses/${record.id}/outcome`, {
        taken,
        outcomePnl: pnl.trim() === "" ? null : Number(pnl),
        outcomeNote: note.trim() || null,
      });
      onSaved(analysis);
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <h3>Your trade journal</h3>
      <p className="small muted">Optional. Recording trades you took lets the dashboard track your daily trade count and loss limit.</p>
      <label className="toggle">
        <input type="checkbox" checked={taken} onChange={(e) => setTaken(e.target.checked)} /> I took this trade manually
      </label>
      {taken && (
        <div className="grid-2">
          <label>
            Result (P&L in account currency)
            <input inputMode="decimal" value={pnl} onChange={(e) => setPnl(e.target.value)} placeholder="e.g. -50 or 120" />
          </label>
          <label>
            Note
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      )}
      <div className="row gap-s">
        <button className="btn" onClick={() => void save()}>
          Save
        </button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
    </div>
  );
}

export function AnalysisPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, setData } = useLoader(() => api.get<{ analysis: AnalysisRecord }>(`/analyses/${id}`).then((r) => r.analysis), [id]);
  const pending = data && (data.status === "queued" || data.status === "processing");
  const [retrying, setRetrying] = useState(false);

  useInterval(
    async () => {
      try {
        setData((await api.get<{ analysis: AnalysisRecord }>(`/analyses/${id}`)).analysis);
      } catch {
        /* keep polling */
      }
    },
    pending ? 3000 : null,
  );

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const remove = async () => {
    if (!confirm("Delete this analysis and its screenshots?")) return;
    await api.del(`/analyses/${data.id}`);
    navigate("/history");
  };
  const retry = async () => {
    setRetrying(true);
    try {
      const { analysis } = await api.post<{ analysis: AnalysisRecord }>(`/analyses/${data.id}/retry`);
      navigate(`/analysis/${analysis.id}`, { replace: true });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <Link to="/history" className="small">
            ← History
          </Link>
          <h1>
            {data.symbol ?? "Chart"} <span className="muted small">{fmtDate(data.createdAt)}</span>
          </h1>
        </div>
        <div className="row gap-s">
          {data.usage && (
            <span className="small muted" title={`${data.usage.inputTokens} input / ${data.usage.outputTokens} output tokens`}>
              AI cost ≈ {fmtUsd(data.usage.costUsd)} · {data.usage.model}
            </span>
          )}
          <button className="btn ghost small danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>

      {pending && <Progress record={data} />}
      {data.status === "failed" && (
        <div className="alert error">
          <strong>The analysis could not be completed.</strong> {data.error}{" "}
          <button className="btn small" disabled={retrying} onClick={() => void retry()}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      <div className={data.status === "completed" ? "analysis-layout" : "stack"}>
        <div className="charts stack">
          {data.images.map((img, i) =>
            data.result ? (
              <ChartAnnotator key={img.key} analysisId={data.id} analysis={data.result} imageIndex={i} src={imageUrl(data.id, i)} width={img.width} height={img.height} label={img.label} />
            ) : (
              <figure key={img.key} className="card">
                <figcaption className="small">{img.label ?? `Screenshot ${i + 1}`}</figcaption>
                <img className="plain-chart" src={imageUrl(data.id, i)} alt={`Chart ${i + 1}`} />
              </figure>
            ),
          )}
          {data.status === "completed" && <OutcomeForm record={data} onSaved={setData} />}
        </div>
        {data.status === "completed" && data.result && data.derived && (
          <div className="report-col">
            <AnalysisReport record={data} />
          </div>
        )}
      </div>
    </div>
  );
}
