import { useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { AnalysisRecord, WatchlistItem } from "../../shared/types.ts";
import { api, ApiError } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { guessTimeframe, prepareImage, type PreparedImage } from "../lib/compress.ts";

const TIMEFRAMES = ["1D", "4h", "1h", "30m", "15m", "5m", "1m"];
const rank = (tf: string | null) => (tf && TIMEFRAMES.includes(tf) ? TIMEFRAMES.indexOf(tf) : 99);

interface Item extends PreparedImage {
  id: string;
  label: string | null;
  name: string;
}

export function UploadPanel({ onSubmitted }: { onSubmitted?: () => void }) {
  const { config } = useAuth();
  const navigate = useNavigate();
  const maxImages = config?.maxImages ?? 6;
  const maxBytes = config?.maxImageBytes ?? 1_500_000;
  const [items, setItems] = useState<Item[]>([]);
  const [symbol, setSymbol] = useState("");
  const [notes, setNotes] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<AnalysisRecord | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ items: WatchlistItem[] }>("/watchlist")
      .then((r) => setSymbols(r.items.map((i) => i.symbol)))
      .catch(() => undefined);
  }, []);
  useEffect(() => () => items.forEach((i) => URL.revokeObjectURL(i.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async (files: FileList | File[]) => {
    setError(null);
    setDuplicate(null);
    const list = [...files];
    if (items.length + list.length > maxImages) {
      setError(`You can analyse up to ${maxImages} screenshots at once.`);
      return;
    }
    setPreparing(true);
    const next: Item[] = [];
    for (const f of list) {
      try {
        const p = await prepareImage(f, maxBytes);
        if ([...items, ...next].some((i) => i.sha256 === p.sha256)) {
          setError(`${f.name} is identical to a screenshot already added.`);
          URL.revokeObjectURL(p.previewUrl);
          continue;
        }
        next.push({ ...p, id: crypto.randomUUID(), label: guessTimeframe(f.name), name: f.name });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    // Higher timeframes first: the analysis reads context top-down.
    setItems((cur) => [...cur, ...next].sort((a, b) => rank(a.label) - rank(b.label)));
    setPreparing(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  // Paste a screenshot straight from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) void addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const submit = async (force = false) => {
    if (!items.length) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    items.forEach((i) => fd.append("images", i.file, i.name));
    fd.append("labels", JSON.stringify(items.map((i) => i.label)));
    if (symbol.trim()) fd.append("symbol", symbol.trim());
    if (notes.trim()) fd.append("notes", notes.trim());
    if (force) fd.append("force", "true");
    try {
      const res = await api.post<{ duplicate: boolean; analysis: AnalysisRecord }>("/analyses", fd);
      if (res.duplicate) {
        setDuplicate(res.analysis);
      } else {
        items.forEach((i) => URL.revokeObjectURL(i.previewUrl));
        setItems([]);
        setNotes("");
        onSubmitted?.();
        navigate(`/analysis/${res.analysis.id}`);
      }
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const totalKb = Math.round(items.reduce((s, i) => s + i.file.size, 0) / 1024);
  const missingLabels = items.some((i) => !i.label);

  return (
    <section className="card upload">
      <h2>New analysis</h2>
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <strong>Drop chart screenshots here</strong>
        <span className="muted small">
          or click to choose, or paste (Ctrl/Cmd+V). Up to {maxImages} timeframes of the same instrument — e.g. 1D, 4H, 1H,
          15M, 5M. PNG, JPEG or WebP.
        </span>
        {preparing && <span className="small">Preparing images…</span>}
      </div>

      {items.length > 0 && (
        <ul className="thumbs">
          {items.map((it, idx) => (
            <li key={it.id} className="thumb">
              <img src={it.previewUrl} alt={`Screenshot ${idx + 1}`} />
              <div className="thumb-meta">
                <select
                  value={it.label ?? ""}
                  onChange={(e) =>
                    setItems((cur) =>
                      cur.map((c) => (c.id === it.id ? { ...c, label: e.target.value || null } : c)).sort((a, b) => rank(a.label) - rank(b.label)),
                    )
                  }
                  aria-label="Timeframe"
                >
                  <option value="">Timeframe?</option>
                  {TIMEFRAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span className="tiny muted">
                  {it.width}×{it.height} · {Math.round(it.file.size / 1024)} KB
                </span>
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

      <div className="grid-2">
        <label>
          Symbol (optional)
          <input list="symbols" placeholder="Read from chart if blank" value={symbol} maxLength={32} onChange={(e) => setSymbol(e.target.value)} />
          <datalist id="symbols">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label>
          Notes for the analyst (optional)
          <input placeholder="e.g. London session, news at 13:30" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      {config?.aiProvider === "gemini" && (
        <p className="tiny muted">
          Free AI mode (Google Gemini free tier): Google may use uploaded screenshots to improve its products. Don't upload anything private, such as
          account numbers or balances.
        </p>
      )}
      {missingLabels && items.length > 0 && (
        <p className="small muted">Tip: set each screenshot's timeframe. If unset, the AI will try to read it from the chart.</p>
      )}
      {items.length === 1 && <p className="small muted">Only one timeframe: higher-timeframe confirmation will be unavailable.</p>}
      {error && <div className="alert error">{error}</div>}
      {duplicate && (
        <div className="alert info">
          These exact screenshots were already analysed. <a href={`/analysis/${duplicate.id}`}>Open the earlier analysis</a> (no new AI
          cost) or{" "}
          <button className="btn link" onClick={() => void submit(true)}>
            analyse again
          </button>
          .
        </div>
      )}
      <div className="row between">
        <span className="small muted">{items.length ? `${items.length} image(s), ${totalKb} KB after compression` : ""}</span>
        <button className="btn primary" disabled={!items.length || busy || preparing} onClick={() => void submit(false)}>
          {busy ? "Analysing… (up to ~1 min)" : "Analyse charts"}
        </button>
      </div>
    </section>
  );
}
