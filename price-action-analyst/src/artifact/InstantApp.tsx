/**
 * Instant-link edition of Price Action Analyst: a single page that runs in the
 * claude.ai artifact viewer. Charts are analysed by Claude on the viewer's own
 * account; history and settings stay in this browser.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import { normalizeSymbol, type AnalysisRecord } from "../../shared/types.ts";
import { CHAT_INSTRUCTIONS } from "../../shared/chat-instructions.ts";
import { applyGuardrails } from "../../server/analysis/guardrails.ts";
import { mockAnalysis } from "../../server/ai/mock.ts";
import { AnalysisReport } from "../components/AnalysisReport.tsx";
import { DecisionBadge, GradeBadge } from "../components/Badges.tsx";
import { ChartAnnotator } from "../components/ChartAnnotator.tsx";
import { Disclaimer } from "../components/Disclaimer.tsx";
import { guessTimeframe, newId, prepareImage, type PreparedImage } from "../lib/compress.ts";
import { fmtDate, fmtRr } from "../lib/format.ts";
import { Calibrator, type CalibratedChart } from "./Calibrator.tsx";
import { AnalyseError, analyseChartData, analyseCharts, getDownloads, getSample, type DownloadsNs, type SampleFn } from "./bridge.ts";
import exampleChart from "./example-chart.png?inline";
import { deleteAnalysis, listAnalyses, loadSettings, saveAnalysis, saveSettings, type InstantSettings, type SavedAnalysis } from "./store.ts";

const TIMEFRAMES = ["1D", "4h", "1h", "30m", "15m", "5m", "1m"];
const rank = (tf: string | null) => (tf && TIMEFRAMES.includes(tf) ? TIMEFRAMES.indexOf(tf) : 99);
type View = { name: "analyse" } | { name: "result"; id: string } | { name: "history" } | { name: "settings" };

interface Item extends PreparedImage {
  id: string;
  label: string | null;
  name: string;
}

function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(",", 2) as [string, string];
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: head.slice(5).split(";")[0] });
}

/** A clearly labelled example so the page shows what it does before the first upload. */
async function buildExample(settings: InstantSettings): Promise<SavedAnalysis> {
  const blob = dataUrlToBlob(exampleChart);
  const raw = mockAnalysis({ images: [{ data: new Uint8Array(), mime: "image/png", label: "15m", width: 1400, height: 800 }], symbolHint: "XAUUSD", notes: null });
  const result = JSON.parse(JSON.stringify(raw).replaceAll("MOCK: ", "").replaceAll(" — MOCK", "")) as ChartAnalysis;
  result.readability_issues = ["EXAMPLE on a synthetic chart, to show the layout. Not a real market reading."];
  result.setup.confluence = result.setup.confluence.map((c) => ({ ...c, note: "" }));
  result.timeframes = ["15m"];
  const derived = applyGuardrails({ analysis: result, settings, pointValue: settings.pointValues["XAUUSD"] ?? null });
  return { id: "example", createdAt: new Date().toISOString(), symbol: "XAUUSD", images: [{ blob, label: "15m", width: 1400, height: 800 }], result, derived, deep: false, example: true };
}

function toRecord(a: SavedAnalysis): AnalysisRecord {
  return {
    id: a.id, userId: "", status: "completed", createdAt: a.createdAt, completedAt: a.createdAt, symbol: a.symbol, symbolHint: a.symbol,
    timeframes: a.result.timeframes, images: [], notes: null, inputHash: "", result: a.result, derived: a.derived, error: null, usage: null,
    taken: false, takenAt: null, outcomePnl: null, outcomeNote: null,
  };
}

function ResultView({ a, downloads, onBack, onDelete }: { a: SavedAnalysis; downloads: DownloadsNs | null; onBack: () => void; onDelete?: () => void }) {
  const urls = useMemo(() => a.images.map((i) => URL.createObjectURL(i.blob)), [a]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = downloads
    ? async (filename: string, png: Blob) => {
        try {
          await downloads.save({ filename, data: png });
        } catch {
          setNote("The image was not saved.");
        }
      }
    : undefined;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row gap-s wrap">
          <button className="btn small ghost" onClick={onBack}>
            ← Back
          </button>
          <strong>{a.symbol ?? "Chart"}</strong>
          <span className="small muted">{a.example ? "Example" : fmtDate(a.createdAt)}</span>
          {a.deep && <span className="tag">deep analysis</span>}
        </div>
        {onDelete &&
          (confirming ? (
            <span className="row gap-s">
              <span className="small">Delete this analysis?</span>
              <button className="btn small danger" onClick={onDelete}>
                Delete
              </button>
              <button className="btn small ghost" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn small ghost danger" onClick={() => setConfirming(true)}>
              Delete
            </button>
          ))}
      </div>
      {note && <p className="small error-text">{note}</p>}
      <div className="analysis-layout">
        <div className="charts stack">
          {a.images.map((img, i) => (
            <ChartAnnotator
              key={i}
              analysisId={a.id}
              analysis={a.result}
              imageIndex={i}
              src={urls[i]!}
              width={img.width}
              height={img.height}
              label={img.label}
              onDownload={save}
            />
          ))}
        </div>
        <div className="report-col">
          <AnalysisReport record={toRecord(a)} />
        </div>
      </div>
    </div>
  );
}

export function InstantApp() {
  const [sample, setSample] = useState<SampleFn | null | undefined>(undefined);
  const [downloads, setDownloads] = useState<DownloadsNs | null>(null);
  const [maxImages, setMaxImages] = useState(6);
  /** true = view reports image support, false = it reports none, null = unknown (try anyway). */
  const [imagesOk, setImagesOk] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<InstantSettings>(loadSettings);
  const [history, setHistory] = useState<SavedAnalysis[]>([]);
  const [example, setExample] = useState<SavedAnalysis | null>(null);
  const [view, setView] = useState<View>({ name: "analyse" });

  const [items, setItems] = useState<Item[]>([]);
  const [symbol, setSymbol] = useState("");
  const [notes, setNotes] = useState("");
  const [pointValue, setPointValue] = useState("");
  const [deep, setDeep] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noImages, setNoImages] = useState(false);
  /** Per-screenshot calibration + measured candles, used when the view can't send images. */
  const [calib, setCalib] = useState<Record<string, CalibratedChart | null>>({});
  const [running, setRunning] = useState<{ started: number; chars: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const ctl = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getSample().then(async (s) => {
      setSample(() => s); // sample is a function: wrap it so React stores it instead of calling it
      if (s) {
        const lim = await s.limits().catch(() => null);
        // Only a definite "no images" answer counts; if limits can't be read, let the call try.
        setImagesOk(lim ? !!lim.images : null);
        if (lim?.images) setMaxImages(Math.min(6, Math.max(1, lim.images.maxCount)));
      }
    });
    void getDownloads().then(setDownloads);
    void listAnalyses().then(setHistory);
    void buildExample(loadSettings()).then(setExample);
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    const n = normalizeSymbol(symbol);
    setPointValue(n && settings.pointValues[n] ? String(settings.pointValues[n]) : "");
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async (files: File[]) => {
    setError(null);
    if (items.length + files.length > maxImages) {
      setError(`You can analyse up to ${maxImages} screenshots at once.`);
      return;
    }
    const next: Item[] = [];
    for (const f of files) {
      try {
        const p = await prepareImage(f, 4_500_000);
        if ([...items, ...next].some((i) => i.sha256 === p.sha256)) continue;
        next.push({ ...p, id: newId(), label: guessTimeframe(f.name), name: f.name });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setItems((cur) => [...cur, ...next].sort((a, b) => rank(a.label) - rank(b.label)));
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length && view.name === "analyse") void addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const analyse = async () => {
    setError(null);
    // Never fail silently: say exactly why analysis can't start.
    if (!items.length) {
      setError("Add at least one chart screenshot first (tap the box above).");
      return;
    }
    if (sample === undefined) {
      setError("Still connecting to Claude. Wait a few seconds and tap Analyse again.");
      return;
    }
    if (!sample) {
      setError("Claude is not available in this view. Open the link in the Claude app or on claude.ai while signed in, then try again.");
      return;
    }
    const dataMode = noImages || imagesOk === false;
    if (dataMode && items.some((i) => !calib[i.id])) {
      setError("Your view can't send pictures, so the bot reads the candles itself: on each chart below, tap two price labels and type their prices. Then press Analyse.");
      return;
    }
    const sym = normalizeSymbol(symbol);
    const pv = pointValue.trim() ? Number(pointValue) : null;
    let s = settings;
    if (sym && pv && pv > 0 && settings.pointValues[sym] !== pv) {
      s = { ...settings, pointValues: { ...settings.pointValues, [sym]: pv } };
      setSettings(s);
      saveSettings(s);
    }
    ctl.current = new AbortController();
    setRunning({ started: Date.now(), chars: 0 });
    try {
      const common = {
        symbol: sym,
        notes: notes.trim() || null,
        minRr: s.minRr,
        deep,
        signal: ctl.current.signal,
        onProgress: (chars: number) => setRunning((r) => (r ? { ...r, chars } : r)),
      };
      const result = dataMode
        ? await analyseChartData(sample, {
            ...common,
            charts: items.map((i) => ({ label: i.label, candles: calib[i.id]!.candles })),
            dims: items.map((i) => ({ width: i.width, height: i.height })),
          })
        : await analyseCharts(sample, { ...common, images: items.map((i) => ({ file: i.file, label: i.label, width: i.width, height: i.height })) });
      if (dataMode) {
        // The user's own calibration places the drawings; the price scale was readable by construction.
        result.calibrations = items.map((i, idx) => {
          const c = calib[i.id]!.cal;
          return { image_index: idx, y1: c.y1, price1: c.price1, y2: c.y2, price2: c.price2, plot_left: 0, plot_right: c.plotRight, scale: "linear" as const, confidence: "high" as const };
        });
        result.charts = items.map((i, idx) => {
          const prev = result.charts.find((c) => c.image_index === idx);
          return {
            image_index: idx,
            detected_symbol: prev?.detected_symbol ?? sym,
            detected_timeframe: i.label ?? prev?.detected_timeframe ?? null,
            timeframe_source: i.label ? ("user_label" as const) : (prev?.timeframe_source ?? "unknown"),
            price_scale_readable: true,
            current_price: calib[i.id]!.candles.at(-1)?.c ?? null,
            usable: true,
            issues: prev?.issues ?? [],
          };
        });
        result.readability_issues = [
          "Candles were measured from your screenshots by the page (this view can't send pictures to Claude). Check the yellow-line preview matched your candles.",
          ...result.readability_issues,
        ];
      }
      const finalSymbol = sym ?? normalizeSymbol(result.symbol);
      const derived = applyGuardrails({ analysis: result, settings: s, pointValue: finalSymbol ? (s.pointValues[finalSymbol] ?? null) : null });
      const saved: SavedAnalysis = {
        id: newId(),
        createdAt: new Date().toISOString(),
        symbol: finalSymbol,
        images: items.map((i) => ({ blob: i.file, label: i.label, width: i.width, height: i.height })),
        result,
        derived,
        deep,
      };
      await saveAnalysis(saved);
      setHistory((h) => [saved, ...h]);
      items.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setItems([]);
      setCalib({});
      setNotes("");
      setView({ name: "result", id: saved.id });
    } catch (e) {
      const msg = e instanceof AnalyseError ? e.message : "Something went wrong. Try again.";
      if (msg.includes("images_unavailable")) {
        setNoImages(true);
        setImagesOk(false);
        setError("Your view can't send pictures to Claude, so the bot will read the candles itself: on each chart below, tap two price labels and type their prices. Then press Analyse again.");
      } else setError(msg);
    } finally {
      setRunning(null);
    }
  };

  const current = view.name === "result" ? (view.id === "example" ? example : history.find((h) => h.id === view.id)) : null;

  return (
    <div className="instant">
      <header className="instant-head">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--surface-2)" />
            <path d="M8 7v18M8 11h-2v8h2M16 5v20M16 9h-2v6h2M24 9v18M24 14h-2v9h2" stroke="var(--accent)" strokeWidth="2" fill="none" />
          </svg>
          <span>Price Action Analyst</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {(["analyse", "history", "settings"] as const).map((n) => (
            <button key={n} className={view.name === n ? "active" : ""} onClick={() => setView({ name: n } as View)}>
              {n === "analyse" ? "Analyse" : n === "history" ? `History${history.length ? ` (${history.length})` : ""}` : "Settings"}
            </button>
          ))}
        </nav>
      </header>

      {view.name === "analyse" && (
        <div className="stack">
          <section className="card upload">
            <h2>Analyse your charts</h2>
            <p className="small muted">
              Upload screenshots of one instrument on several timeframes (for example 4H, 1H, 15M). Claude reads them like a price-action trader — structure,
              liquidity, zones, FVGs, order blocks, BOS/CHOCH — and gives a setup or <strong>NO TRADE — WAIT</strong>. No indicators. Nothing is traded.
            </p>
            {sample === null && (
              <div className="alert warn small">
                Live analysis works when this page is opened inside Claude (the Claude app or claude.ai). Here you can still look at the example below.
              </div>
            )}
            <input
              id="chart-files"
              ref={fileRef}
              className="visually-hidden"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                if (e.target.files) void addFiles([...e.target.files]);
                e.target.value = "";
              }}
            />
            {/* A native label opens the file picker reliably on phones, without scripted clicks. */}
            <label
              htmlFor="chart-files"
              className={`dropzone${dragging ? " dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setDragging(false);
                void addFiles([...e.dataTransfer.files]);
              }}
            >
              <strong>Tap to choose chart screenshots</strong>
              <span className="muted small">or drop / paste them here · up to {maxImages} timeframes · PNG, JPEG, WebP</span>
            </label>

            {items.length > 0 && (
              <ul className="thumbs">
                {items.map((it, idx) => (
                  <li key={it.id} className="thumb">
                    <img src={it.previewUrl} alt={`Screenshot ${idx + 1}`} />
                    <div className="thumb-meta">
                      <select
                        id={`tf-${it.id}`}
                        aria-label="Timeframe"
                        value={it.label ?? ""}
                        onChange={(e) =>
                          setItems((cur) => cur.map((c) => (c.id === it.id ? { ...c, label: e.target.value || null } : c)).sort((a, b) => rank(a.label) - rank(b.label)))
                        }
                      >
                        <option value="">Timeframe?</option>
                        {TIMEFRAMES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <button
                        className="btn link tiny"
                        onClick={() => {
                          URL.revokeObjectURL(it.previewUrl);
                          setItems((cur) => cur.filter((c) => c.id !== it.id));
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid-3">
              <label>
                Symbol (optional)
                <input id="symbol" value={symbol} maxLength={32} placeholder="e.g. XAUUSD" onChange={(e) => setSymbol(e.target.value)} />
              </label>
              <label>
                Value of a 1.0 move per lot (optional)
                <input id="point-value" inputMode="decimal" value={pointValue} placeholder="for position size" onChange={(e) => setPointValue(e.target.value)} />
              </label>
              <label>
                Notes (optional)
                <input id="notes" value={notes} maxLength={500} placeholder="e.g. London open" onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>
            <label className="toggle">
              <input id="deep" type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> Deep analysis (slower, uses Claude's most capable
              model)
            </label>
            {items.length === 1 && <p className="small muted">Only one timeframe: higher-timeframe confirmation will be unavailable.</p>}
            {(noImages || (sample && imagesOk === false)) && items.length > 0 && (
              <div className="data-mode">
                <div>
                  <strong>Read the candles (works in every Claude view)</strong>
                  <p className="small muted">
                    This view can't send pictures to Claude, so the bot measures the candles on your phone and sends Claude the prices. For each chart: tap a
                    price label near the top of the price axis and type its price, then one near the bottom.
                  </p>
                </div>
                {items.map((it, idx) => (
                  <Calibrator
                    key={it.id}
                    index={idx}
                    label={it.label}
                    src={it.previewUrl}
                    file={it.file}
                    width={it.width}
                    height={it.height}
                    value={calib[it.id] ?? null}
                    onChange={(v) => setCalib((c) => ({ ...c, [it.id]: v }))}
                  />
                ))}
                <details>
                  <summary className="small">Other option: use the analyst in a normal Claude chat</summary>
                  <ChatFallback />
                </details>
              </div>
            )}
            {error && <div className="alert error small">{error}</div>}
            {running ? (
              <div className="progress-row">
                <div className="spinner" aria-hidden />
                <div className="grow">
                  <strong>{running.chars ? "Writing the analysis…" : "Claude is reading the charts…"}</strong>
                  <div className="small muted">
                    {Math.round((now - running.started) / 1000)} s · usually 30–120 s{deep ? " (deep mode can take longer)" : ""}
                  </div>
                </div>
                <button className="btn small" onClick={() => ctl.current?.abort()}>
                  Stop
                </button>
              </div>
            ) : (
              <div className="row between wrap">
                <span className="tiny muted">
                  <span className={`status-dot ${sample ? "ok" : sample === null ? "bad" : "wait"}`} aria-hidden />{" "}
                  {sample ? "Connected to Claude" : sample === null ? "Claude not available in this view" : "Connecting to Claude…"} · uses your own Claude usage; Claude asks once for permission.
                </span>
                <button className="btn primary" onClick={() => void analyse()}>
                  Analyse charts
                </button>
              </div>
            )}
          </section>

          {history.length > 0 ? (
            <section className="card">
              <h3>Recent</h3>
              <HistoryList items={history.slice(0, 5)} open={(id) => setView({ name: "result", id })} />
            </section>
          ) : (
            example && (
              <section className="stack">
                <div className="row between wrap">
                  <h3 className="no-margin">Example result</h3>
                  <span className="small muted">Synthetic chart, for illustration only</span>
                </div>
                <ResultView a={example} downloads={downloads} onBack={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
              </section>
            )
          )}
        </div>
      )}

      {view.name === "result" && current && (
        <ResultView
          a={current}
          downloads={downloads}
          onBack={() => setView(current.example ? { name: "analyse" } : { name: "history" })}
          onDelete={
            current.example
              ? undefined
              : async () => {
                  await deleteAnalysis(current.id);
                  setHistory((h) => h.filter((x) => x.id !== current.id));
                  setView({ name: "history" });
                }
          }
        />
      )}

      {view.name === "history" && (
        <section className="card">
          <h2>History</h2>
          <p className="small muted">Saved in this browser only.</p>
          {history.length ? <HistoryList items={history} open={(id) => setView({ name: "result", id })} /> : <p className="muted small">No analyses yet.</p>}
        </section>
      )}

      {view.name === "settings" && <SettingsCard settings={settings} onSave={(s) => (setSettings(s), saveSettings(s))} />}

      <footer className="footer">
        <Disclaimer />
        <p className="tiny muted">Analysis assistant only. It never places trades and is not financial advice.</p>
      </footer>
    </div>
  );
}

function HistoryList({ items, open }: { items: SavedAnalysis[]; open: (id: string) => void }) {
  return (
    <ul className="history">
      {items.map((h) => (
        <li key={h.id}>
          <button className="history-row" onClick={() => open(h.id)}>
            <span className="history-sym">{h.symbol ?? "Chart"}</span>
            <span className="small muted">{h.images.map((i) => i.label ?? "?").join(" · ")}</span>
            <span className="row gap-s wrap">
              <DecisionBadge decision={h.derived.finalDecision} />
              <GradeBadge grade={h.derived.grade} />
              {h.derived.rr?.primary != null && <span className="tag">R:R {fmtRr(h.derived.rr.primary)}</span>}
            </span>
            <span className="tiny muted">{fmtDate(h.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SettingsCard({ settings, onSave }: { settings: InstantSettings; onSave: (s: InstantSettings) => void }) {
  const [s, setS] = useState(settings);
  const [balance, setBalance] = useState(settings.accountBalance?.toString() ?? "");
  const [saved, setSaved] = useState(false);
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  return (
    <section className="card stack">
      <h2>Money management</h2>
      <p className="small muted">Recommended risk: about 0.5%–1% of your account per trade. Used for position size and to filter weak setups. Saved in this browser.</p>
      <div className="grid-3">
        <label>
          Account balance
          <input id="balance" inputMode="decimal" value={balance} placeholder="optional" onChange={(e) => setBalance(e.target.value)} />
        </label>
        <label>
          Currency
          <input id="currency" value={s.accountCurrency} maxLength={5} onChange={(e) => setS({ ...s, accountCurrency: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Risk per trade (%)
          <input id="risk" type="number" step="any" min="0.01" max="5" value={s.riskPercent} onChange={(e) => setS({ ...s, riskPercent: Math.min(5, num(e.target.value, 1)) })} />
        </label>
        <label>
          Minimum R:R (1:x)
          <input id="minrr" type="number" step="any" min="0.5" max="20" value={s.minRr} onChange={(e) => setS({ ...s, minRr: num(e.target.value, 2) })} />
        </label>
        <label>
          Minimum setup grade
          <select id="mingrade" value={s.minGrade} onChange={(e) => setS({ ...s, minGrade: e.target.value as InstantSettings["minGrade"] })}>
            {["A+", "A", "B", "C"].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
      </div>
      {s.riskPercent > 1 && <p className="tiny warn-text">Above the recommended 0.5%–1%.</p>}
      <div className="row gap-s">
        <button
          className="btn primary"
          onClick={() => {
            const b = balance.trim() ? Number(balance) : null;
            onSave({ ...s, accountBalance: b && b > 0 ? b : null });
            setSaved(true);
          }}
        >
          Save settings
        </button>
        {saved && <span className="small">Saved. Applies to new analyses.</span>}
      </div>
    </section>
  );
}

/** Shown when this view can't send images: the same analyst, used directly in a Claude chat. */
function ChatFallback() {
  const [copied, setCopied] = useState<"yes" | "select" | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CHAT_INSTRUCTIONS);
      setCopied("yes");
    } catch {
      ref.current?.select();
      setCopied("select");
    }
  };
  return (
    <div ref={box} className="alert warn stack fallback">
      <div>
        <strong>This Claude view can't send images from a page.</strong>
        <p className="small">Two ways to analyse your charts right now:</p>
      </div>
      <ol className="small">
        <li>
          Open this same link in a <strong>web browser</strong> (Chrome or Safari) at claude.ai, signed in to your account, and analyse there.
        </li>
        <li>
          Or use the analyst in a normal Claude chat: tap <strong>Copy instructions</strong>, start a new chat (or a Claude Project and paste them as the
          project instructions), paste, then attach your chart screenshots and send. Same rules and the same 13-section report.
        </li>
      </ol>
      <div className="row gap-s wrap">
        <button className="btn primary small" onClick={() => void copy()}>
          Copy instructions
        </button>
        {copied === "yes" && <span className="small">Copied. Paste it into a new Claude chat with your screenshots.</span>}
        {copied === "select" && <span className="small">Selected below. Use your phone's Copy.</span>}
      </div>
      <textarea id="chat-instructions" ref={ref} className="instructions" readOnly value={CHAT_INSTRUCTIONS} rows={6} />
    </div>
  );
}
