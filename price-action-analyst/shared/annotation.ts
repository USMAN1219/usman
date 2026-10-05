/**
 * Turns an analysis into drawable chart annotations.
 *
 * The model reports prices, not pixels. To place a price on the screenshot we
 * need a price-axis calibration: two readable axis labels and their vertical
 * positions. A linear mapping between them converts any price to a y position.
 * If the calibration is missing, implausible, or the axis is logarithmic, we do
 * not annotate at all - drawing a level in the wrong place is worse than not
 * drawing it.
 */
import type { Calibration, ChartAnalysis } from "./analysis-schema.ts";

export interface AxisMapping {
  imageIndex: number;
  /** Price -> fraction of image height. */
  priceToY: (price: number) => number;
  plotLeft: number;
  plotRight: number;
  source: "ai" | "manual";
  confidence: Calibration["confidence"];
}

export type CalibrationInput = Pick<
  Calibration,
  "image_index" | "y1" | "price1" | "y2" | "price2" | "plot_left" | "plot_right" | "scale" | "confidence"
>;

const inUnit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

export function validateCalibration(c: CalibrationInput): string | null {
  if (c.scale === "logarithmic") return "Price axis is logarithmic; linear placement would be inaccurate.";
  if (c.confidence === "low") return "Price-axis calibration confidence is low.";
  if (![c.y1, c.y2, c.plot_left, c.plot_right].every(inUnit)) return "Calibration positions are out of range.";
  if (!(Number.isFinite(c.price1) && Number.isFinite(c.price2))) return "Calibration prices are invalid.";
  if (c.price1 === c.price2 || Math.abs(c.y1 - c.y2) < 0.1)
    return "Calibration labels are too close together to be reliable.";
  // Higher prices must be drawn higher on the chart (smaller y).
  if ((c.price1 > c.price2) !== (c.y1 < c.y2)) return "Calibration is inverted (higher price lower on chart).";
  if (!(c.plot_right > c.plot_left + 0.2)) return "Plot area bounds are implausible.";
  return null;
}

export function buildMapping(c: CalibrationInput, source: "ai" | "manual" = "ai"): AxisMapping | null {
  if (validateCalibration(c)) return null;
  const slope = (c.y2 - c.y1) / (c.price2 - c.price1);
  return {
    imageIndex: c.image_index,
    priceToY: (p) => c.y1 + (p - c.price1) * slope,
    plotLeft: c.plot_left,
    plotRight: c.plot_right,
    source,
    confidence: c.confidence,
  };
}

export type AnnotationKind =
  | "support"
  | "resistance"
  | "liquidity"
  | "sweep"
  | "supply"
  | "demand"
  | "fvg"
  | "order_block"
  | "structure"
  | "entry"
  | "stop"
  | "target";

export interface LineAnnotation {
  shape: "line";
  kind: AnnotationKind;
  y: number;
  x1: number;
  x2: number;
  label: string;
}
export interface BoxAnnotation {
  shape: "box";
  kind: AnnotationKind;
  yTop: number;
  yBottom: number;
  x1: number;
  x2: number;
  label: string;
}
export interface MarkerAnnotation {
  shape: "marker";
  kind: AnnotationKind;
  x: number;
  y: number;
  label: string;
}
export type Annotation = LineAnnotation | BoxAnnotation | MarkerAnnotation;

const fmt = (p: number) => (Math.abs(p) >= 1000 ? p.toFixed(1) : Math.abs(p) >= 10 ? p.toFixed(2) : p.toPrecision(5));

/** Items are drawn only on the image they belong to, or on every image when unassigned. */
function belongs(itemIndex: number | null, imageIndex: number) {
  return itemIndex == null || itemIndex === imageIndex;
}

/**
 * Builds annotations for one image. Anything mapped outside the visible chart
 * (beyond a small margin) is skipped rather than clamped, so we never draw a
 * misleading line at the edge.
 */
export function buildAnnotations(analysis: ChartAnalysis, mapping: AxisMapping): Annotation[] {
  const out: Annotation[] = [];
  const idx = mapping.imageIndex;
  const { plotLeft, plotRight } = mapping;
  const y = (p: number) => mapping.priceToY(p);
  const visible = (v: number) => v >= -0.01 && v <= 1.01;
  const xStart = (x: number | null) => (x != null && x >= plotLeft && x < plotRight ? x : plotLeft);

  const line = (kind: AnnotationKind, price: number, label: string, x1 = plotLeft) => {
    const yy = y(price);
    if (visible(yy)) out.push({ shape: "line", kind, y: yy, x1, x2: plotRight, label: `${label} ${fmt(price)}` });
  };
  const box = (kind: AnnotationKind, low: number, high: number, label: string, x1: number) => {
    const a = y(Math.max(low, high));
    const b = y(Math.min(low, high));
    if (visible(a) && visible(b))
      out.push({ shape: "box", kind, yTop: a, yBottom: b, x1, x2: plotRight, label: `${label} ${fmt(low)}-${fmt(high)}` });
  };

  for (const l of analysis.levels) {
    if (!belongs(l.image_index, idx)) continue;
    const name = `${l.kind === "support" ? "Support" : "Resistance"}${l.importance === "major" ? " (major)" : ""}`;
    if (l.price_high != null && l.price_high !== l.price) box(l.kind, l.price, l.price_high, name, xStart(l.x_start));
    else line(l.kind, l.price, name, xStart(l.x_start));
  }
  for (const z of analysis.zones) {
    if (!belongs(z.image_index, idx) || z.grade === "weak") continue;
    box(z.kind, z.price_low, z.price_high, `${z.kind === "demand" ? "Demand" : "Supply"} ${z.grade}`, xStart(z.x_start));
  }
  for (const f of analysis.fvgs) {
    if (!belongs(f.image_index, idx) || f.status === "filled" || f.status === "invalidated") continue;
    box("fvg", f.price_low, f.price_high, `${f.direction === "bullish" ? "Bull" : "Bear"} FVG`, xStart(f.x_start));
  }
  for (const ob of analysis.order_blocks) {
    if (!belongs(ob.image_index, idx) || ob.quality === "weak" || ob.status === "invalidated") continue;
    box("order_block", ob.price_low, ob.price_high, `${ob.direction === "bullish" ? "Bull" : "Bear"} OB ${ob.quality}`, xStart(ob.x_start));
  }
  for (const p of analysis.liquidity.pools) {
    if (!belongs(p.image_index, idx) || p.status === "fully_taken") continue;
    line("liquidity", p.price, p.type.includes("high") ? "BSL" : p.type.includes("low") ? "SSL" : "Liquidity");
  }
  for (const s of analysis.liquidity.sweeps) {
    if (!belongs(s.image_index, idx) || s.x == null) continue;
    const yy = y(s.price);
    if (visible(yy)) out.push({ shape: "marker", kind: "sweep", x: s.x, y: yy, label: s.side === "buy_side" ? "BSL sweep" : "SSL sweep" });
  }
  for (const e of analysis.structure.events) {
    if (!belongs(e.image_index, idx) || e.x == null || e.level_price == null) continue;
    const yy = y(e.level_price);
    if (visible(yy)) out.push({ shape: "marker", kind: "structure", x: e.x, y: yy, label: `${e.type} ${e.direction === "bullish" ? "↑" : "↓"}` });
  }

  const s = analysis.setup;
  if (s.direction !== "no_trade") {
    if (s.entry_low != null && s.entry_high != null && s.entry_low !== s.entry_high) box("entry", s.entry_low, s.entry_high, "Entry", plotLeft + (plotRight - plotLeft) * 0.6);
    else if (s.entry_low ?? s.entry_high) line("entry", (s.entry_low ?? s.entry_high)!, "Entry", plotLeft + (plotRight - plotLeft) * 0.6);
    if (s.stop_loss != null) line("stop", s.stop_loss, "SL", plotLeft + (plotRight - plotLeft) * 0.6);
    if (s.tp1 != null) line("target", s.tp1, "TP1", plotLeft + (plotRight - plotLeft) * 0.6);
    if (s.tp2 != null) line("target", s.tp2, "TP2", plotLeft + (plotRight - plotLeft) * 0.6);
    if (s.tp3 != null) line("target", s.tp3, "TP3", plotLeft + (plotRight - plotLeft) * 0.6);
  }
  return out;
}
