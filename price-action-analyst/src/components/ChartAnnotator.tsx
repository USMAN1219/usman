/**
 * Shows a screenshot with an SVG overlay of the analysis levels.
 *
 * Placement depends on a price-axis calibration. The AI proposes one; if it is
 * missing or implausible we do not draw anything and let the user calibrate
 * manually by clicking two price-axis labels and typing their prices.
 */
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { buildAnnotations, buildMapping, validateCalibration, type Annotation, type AnnotationKind, type CalibrationInput } from "../../shared/annotation.ts";
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";

const COLORS: Record<AnnotationKind, string> = {
  support: "#22c55e",
  resistance: "#ef4444",
  liquidity: "#eab308",
  sweep: "#f97316",
  supply: "#f43f5e",
  demand: "#10b981",
  fvg: "#a855f7",
  order_block: "#3b82f6",
  structure: "#38bdf8",
  entry: "#0ea5e9",
  stop: "#dc2626",
  target: "#16a34a",
};

const LAYERS: { key: string; label: string; kinds: AnnotationKind[] }[] = [
  { key: "sr", label: "Support / Resistance", kinds: ["support", "resistance"] },
  { key: "sd", label: "Supply / Demand", kinds: ["supply", "demand"] },
  { key: "liq", label: "Liquidity & sweeps", kinds: ["liquidity", "sweep"] },
  { key: "fvg", label: "FVG", kinds: ["fvg"] },
  { key: "ob", label: "Order blocks", kinds: ["order_block"] },
  { key: "ms", label: "BOS / CHOCH", kinds: ["structure"] },
  { key: "trade", label: "Entry / SL / TP", kinds: ["entry", "stop", "target"] },
];

function storageKey(analysisId: string, index: number) {
  return `paa.calibration.${analysisId}.${index}`;
}
function loadManual(analysisId: string, index: number): CalibrationInput | null {
  try {
    const raw = localStorage.getItem(storageKey(analysisId, index));
    return raw ? (JSON.parse(raw) as CalibrationInput) : null;
  } catch {
    return null;
  }
}

interface Props {
  analysisId: string;
  analysis: ChartAnalysis;
  imageIndex: number;
  src: string;
  width: number;
  height: number;
  label: string | null;
  /** Overrides how the annotated PNG is handed to the user (e.g. the artifact downloads capability). */
  onDownload?: (filename: string, png: Blob) => Promise<void>;
}

export function ChartAnnotator({ analysisId, analysis, imageIndex, src, width, height, label, onDownload }: Props) {
  const [visible, setVisible] = useState<Record<string, boolean>>(() => Object.fromEntries(LAYERS.map((l) => [l.key, true])));
  const [show, setShow] = useState(true);
  const [manual, setManual] = useState<CalibrationInput | null>(() => loadManual(analysisId, imageIndex));
  const [calibrating, setCalibrating] = useState<null | { step: 1 | 2; y1?: number; price1?: number; pendingY?: number }>(null);
  const [priceInput, setPriceInput] = useState("");
  const [calError, setCalError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const aiCal = analysis.calibrations.find((c) => c.image_index === imageIndex) ?? null;
  const calibration = manual ?? aiCal;
  const problem = calibration ? validateCalibration(calibration) : "The AI could not read two price-axis labels on this screenshot.";
  const mapping = useMemo(() => (calibration && !problem ? buildMapping(calibration, manual ? "manual" : "ai") : null), [calibration, problem, manual]);
  const annotations = useMemo(() => (mapping ? buildAnnotations(analysis, mapping) : []), [analysis, mapping]);
  const enabledKinds = new Set(LAYERS.filter((l) => visible[l.key]).flatMap((l) => l.kinds));
  const shown = show ? annotations.filter((a) => enabledKinds.has(a.kind)) : [];

  const fs = Math.max(11, width / 85);
  const sw = Math.max(1.5, width / 700);

  // Right-aligned line labels share the same x, so push apart any that would overlap vertically.
  const labelY = useMemo(() => {
    const ys = new Map<number, number>();
    const lines = shown
      .map((a, i) => ({ i, y: a.shape === "line" ? a.y * height - 4 : null }))
      .filter((l): l is { i: number; y: number } => l.y != null)
      .sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const l of lines) {
      const y = Math.max(l.y, prev + fs * 1.15);
      ys.set(l.i, y);
      prev = y;
    }
    return ys;
  }, [shown, height, fs]);

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!calibrating || calibrating.pendingY != null) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    setCalibrating({ ...calibrating, pendingY: y });
    setPriceInput("");
  };

  const confirmPrice = () => {
    const price = Number(priceInput);
    if (!calibrating || calibrating.pendingY == null || !Number.isFinite(price) || price <= 0) {
      setCalError("Enter the price printed on the axis label you clicked.");
      return;
    }
    setCalError(null);
    if (calibrating.step === 1) {
      setCalibrating({ step: 2, y1: calibrating.pendingY, price1: price });
      return;
    }
    const cal: CalibrationInput = {
      image_index: imageIndex,
      y1: calibrating.y1!,
      price1: calibrating.price1!,
      y2: calibrating.pendingY,
      price2: price,
      plot_left: aiCal?.plot_left ?? 0.02,
      plot_right: aiCal?.plot_right ?? 0.92,
      scale: "linear",
      confidence: "high",
    };
    const err = validateCalibration(cal);
    if (err) {
      setCalError(`${err} Try again with two labels far apart.`);
      setCalibrating({ step: 1 });
      return;
    }
    try {
      localStorage.setItem(storageKey(analysisId, imageIndex), JSON.stringify(cal));
    } catch {
      /* storage unavailable: keep for this session only */
    }
    setManual(cal);
    setCalibrating(null);
  };

  const resetManual = () => {
    try {
      localStorage.removeItem(storageKey(analysisId, imageIndex));
    } catch {
      /* ignore */
    }
    setManual(null);
  };

  const download = async () => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, width, height);
    const svg = svgRef.current!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const overlay = new Image();
    overlay.src = url;
    await overlay.decode();
    ctx.drawImage(overlay, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const filename = `annotated-${analysis.symbol ?? "chart"}-${label ?? imageIndex}.png`;
    if (onDownload) {
      const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (png) await onDownload(filename, png);
      return;
    }
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = filename;
    a.click();
  };

  return (
    <figure className="annotator card">
      <figcaption className="row between wrap">
        <strong>
          {label ? `${label} chart` : `Screenshot ${imageIndex + 1}`}
          {mapping && <span className="tiny muted"> · levels placed by {mapping.source === "manual" ? "your calibration" : "AI axis reading"}</span>}
        </strong>
        <div className="row gap-s wrap">
          {mapping && (
            <label className="toggle">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Annotations
            </label>
          )}
          <button className="btn small ghost" onClick={() => setCalibrating({ step: 1 })} disabled={!!calibrating}>
            {manual ? "Recalibrate" : "Calibrate axis"}
          </button>
          {manual && (
            <button className="btn small ghost" onClick={resetManual}>
              Use AI calibration
            </button>
          )}
          {mapping && (
            <button className="btn small ghost" onClick={() => void download()}>
              Download PNG
            </button>
          )}
        </div>
      </figcaption>

      {calibrating && (
        <div className="alert info small">
          {calibrating.pendingY == null ? (
            <>Step {calibrating.step} of 2: click the centre of a price label on the chart's price axis{calibrating.step === 2 ? " (far from the first one)" : ""}.</>
          ) : (
            <span className="row gap-s wrap">
              Price on that label:
              <input className="inline-input" autoFocus inputMode="decimal" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmPrice()} />
              <button className="btn small primary" onClick={confirmPrice}>
                OK
              </button>
            </span>
          )}{" "}
          <button className="btn link small" onClick={() => setCalibrating(null)}>
            Cancel
          </button>
          {calError && <div className="error-text">{calError}</div>}
        </div>
      )}
      {!mapping && !calibrating && (
        <p className="small muted">
          Annotations hidden: {problem} Levels are listed in the analysis below; use “Calibrate axis” to place them on the chart.
        </p>
      )}

      <div className="chart-wrap" style={{ aspectRatio: `${width} / ${height}` }}>
        <img src={src} alt={`Chart screenshot ${imageIndex + 1}`} width={width} height={height} />
        <svg
          ref={svgRef}
          className={calibrating ? "overlay calibrating" : "overlay"}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onClick={onClick}
          xmlns="http://www.w3.org/2000/svg"
        >
          {shown.map((a, i) => (
            <Shape key={i} a={a} w={width} h={height} fs={fs} sw={sw} labelY={labelY.get(i)} />
          ))}
          {calibrating?.y1 != null && <line x1={0} x2={width} y1={calibrating.y1 * height} y2={calibrating.y1 * height} stroke="#38bdf8" strokeDasharray="6 4" />}
          {calibrating?.pendingY != null && (
            <line x1={0} x2={width} y1={calibrating.pendingY * height} y2={calibrating.pendingY * height} stroke="#38bdf8" strokeDasharray="6 4" />
          )}
        </svg>
      </div>

      {mapping && show && (
        <div className="layer-toggles">
          {LAYERS.map((l) => (
            <label key={l.key} className="toggle small">
              <input type="checkbox" checked={visible[l.key]} onChange={(e) => setVisible((v) => ({ ...v, [l.key]: e.target.checked }))} />
              <span className="swatch" style={{ background: COLORS[l.kinds[0]!] }} /> {l.label}
            </label>
          ))}
        </div>
      )}
      {mapping && <p className="tiny muted">Placement is approximate. Always confirm levels against the price axis on your own chart.</p>}
    </figure>
  );
}

function Shape({ a, w, h, fs, sw, labelY }: { a: Annotation; w: number; h: number; fs: number; sw: number; labelY?: number }) {
  const color = COLORS[a.kind];
  const text = (x: number, y: number, anchor: "start" | "end" = "end") => (
    <text x={x} y={y} fill={color} fontSize={fs} fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={600} textAnchor={anchor} paintOrder="stroke" stroke="rgba(0,0,0,0.65)" strokeWidth={fs / 4}>
      {a.label}
    </text>
  );
  if (a.shape === "line") {
    const dashed = a.kind === "liquidity" ? `${sw * 4} ${sw * 3}` : undefined;
    return (
      <g>
        <line x1={a.x1 * w} x2={a.x2 * w} y1={a.y * h} y2={a.y * h} stroke={color} strokeWidth={a.kind === "entry" || a.kind === "stop" || a.kind === "target" ? sw * 1.6 : sw} strokeDasharray={dashed} />
        {text(a.x2 * w - 4, labelY ?? a.y * h - 4)}
      </g>
    );
  }
  if (a.shape === "box") {
    const y = a.yTop * h;
    const height = Math.max(2, (a.yBottom - a.yTop) * h);
    return (
      <g>
        <rect x={a.x1 * w} y={y} width={(a.x2 - a.x1) * w} height={height} fill={color} fillOpacity={0.16} stroke={color} strokeOpacity={0.8} strokeWidth={sw * 0.8} />
        {text(a.x1 * w + 4, y + fs, "start")}
      </g>
    );
  }
  return (
    <g>
      <circle cx={a.x * w} cy={a.y * h} r={fs * 0.6} fill="none" stroke={color} strokeWidth={sw * 1.4} />
      {text(a.x * w + fs * 0.9, a.y * h - fs * 0.6, "start")}
    </g>
  );
}
