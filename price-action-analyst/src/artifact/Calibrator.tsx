/**
 * "Read the candles" step for views that cannot send images: the viewer taps two
 * price labels on the price axis and types their prices; the page then measures
 * every candle in the screenshot and shows what it found for a quick visual check.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { validateCalibration } from "../../shared/annotation.ts";
import { extractCandles, findAxisLeft, snapToLabelCenter, toPrices, type PriceCandle } from "../../shared/candles.ts";

export interface CalibratedChart {
  cal: { y1: number; price1: number; y2: number; price2: number; plotRight: number };
  candles: PriceCandle[];
  /** Pixel candles for the preview overlay. */
  marks: { x: number; hy: number; ly: number }[];
}

interface Props {
  index: number;
  label: string | null;
  src: string;
  file: Blob;
  width: number;
  height: number;
  value: CalibratedChart | null;
  onChange: (v: CalibratedChart | null) => void;
}

async function pixels(file: Blob, width: number, height: number) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return ctx.getImageData(0, 0, width, height);
}

export function Calibrator({ index, label, src, file, width, height, value, onChange }: Props) {
  const [points, setPoints] = useState<{ x: number; y: number; price?: number }[]>([]);
  const [price, setPrice] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pending = points.length > 0 && points[points.length - 1]!.price == null;

  useEffect(() => {
    if (value) setPoints([]);
  }, [value]);

  const tap = (e: MouseEvent<SVGSVGElement>) => {
    if (value || pending || points.length >= 2) return;
    const r = svg.current!.getBoundingClientRect();
    setPoints((p) => [...p, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }]);
    setPrice("");
    setMsg(null);
  };

  const confirm = async () => {
    const p = Number(price.replace(",", "."));
    if (!Number.isFinite(p) || p <= 0) {
      setMsg("Type the price printed on the label you tapped.");
      return;
    }
    const next = points.map((pt, i) => (i === points.length - 1 ? { ...pt, price: p } : pt));
    setPoints(next);
    if (next.length < 2) return;
    const [ta, tb] = next as [{ x: number; y: number; price: number }, { x: number; y: number; price: number }];
    let a = ta;
    let b = tb;
    let plotRight = Math.max(0.3, Math.min(a.x, b.x) - 0.02);
    const problem = validateCalibration({ image_index: index, y1: a.y, price1: a.price, y2: b.y, price2: b.price, plot_left: 0, plot_right: plotRight, scale: "linear", confidence: "high" });
    if (problem) {
      setMsg(`${problem} Tap two labels far apart, e.g. one near the top and one near the bottom.`);
      setPoints([]);
      return;
    }
    setMsg("Reading candles…");
    try {
      const img = await pixels(file, width, height);
      // Snap each tap to the centre of the label it landed on, then re-check the calibration.
      a = { ...a, y: snapToLabelCenter(img, a.x * width, a.y * height) / height };
      b = { ...b, y: snapToLabelCenter(img, b.x * width, b.y * height) / height };
      // Where the price axis starts: just left of the tapped label text.
      plotRight = Math.max(0.3, Math.min(findAxisLeft(img, a.x * width, a.y * height), findAxisLeft(img, b.x * width, b.y * height)) / width);
      const res = extractCandles(img, plotRight * width);
      if (res.problem) {
        setMsg(res.problem);
        setPoints([]);
        return;
      }
      const { candles } = toPrices(res.candles, { width, height }, { y1: a.y, price1: a.price, y2: b.y, price2: b.price });
      setMsg(null);
      onChange({
        cal: { y1: a.y, price1: a.price, y2: b.y, price2: b.price, plotRight },
        candles,
        marks: res.candles.map((k) => ({ x: (k.x0 + k.x1 + 1) / 2, hy: k.highY, ly: k.lowY + 1 })),
      });
    } catch {
      setMsg("This screenshot could not be read. Try a PNG or JPEG screenshot.");
      setPoints([]);
    }
  };

  const step = value ? null : points.length === 0 ? 1 : points.length === 1 && !pending ? 2 : null;
  const last = useMemo(() => value?.candles.at(-1)?.c, [value]);

  return (
    <div className="calib card">
      <div className="row between wrap">
        <strong>{label ? `${label} chart` : `Chart ${index + 1}`}</strong>
        {value ? (
          <span className="row gap-s wrap">
            <span className="badge long">✓ {value.candles.length} candles read · last {last}</span>
            <button className="btn small ghost" onClick={() => onChange(null)}>
              Redo
            </button>
          </span>
        ) : (
          <span className="small muted">Step {step ?? (points.length === 1 ? 1 : 2)} of 2</span>
        )}
      </div>
      {!value && (
        <p className="small">
          {pending ? (
            <span className="row gap-s wrap">
              Price on that label:
              <input
                id={`cal-price-${index}`}
                className="inline-input"
                inputMode="decimal"
                autoFocus
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void confirm()}
              />
              <button className="btn small primary" onClick={() => void confirm()}>
                OK
              </button>
            </span>
          ) : points.length === 0 ? (
            <>Tap a price label on the right-hand price axis, near the <strong>top</strong> of the chart.</>
          ) : (
            <>Now tap a price label near the <strong>bottom</strong> of the chart.</>
          )}
        </p>
      )}
      {msg && <p className="small warn-text">{msg}</p>}
      <div className="chart-wrap" style={{ aspectRatio: `${width} / ${height}` }}>
        <img src={src} alt={`Chart ${index + 1}`} width={width} height={height} />
        <svg ref={svg} className={value ? "overlay" : "overlay calibrating"} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onClick={tap}>
          {points.map((p, i) => (
            <g key={i}>
              <line x1={0} x2={width} y1={p.y * height} y2={p.y * height} stroke="#38bdf8" strokeDasharray="6 4" strokeWidth={Math.max(1.5, width / 600)} />
              <circle cx={p.x * width} cy={p.y * height} r={Math.max(6, width / 120)} fill="none" stroke="#38bdf8" strokeWidth={2} />
            </g>
          ))}
          {value?.marks.map((m, i) => (
            <line key={i} x1={m.x} x2={m.x} y1={m.hy} y2={m.ly} stroke="#facc15" strokeWidth={Math.max(1, width / 900)} strokeOpacity={0.9} />
          ))}
        </svg>
      </div>
      {value && <p className="tiny muted">Yellow lines show each candle the page read (high to low). If they don't sit on the candles, tap Redo.</p>}
    </div>
  );
}
