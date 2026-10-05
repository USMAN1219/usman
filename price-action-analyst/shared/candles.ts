/**
 * Reads candlesticks out of a chart screenshot's pixels (no AI, no network).
 *
 * Used when a view cannot send images to the model: the page measures each
 * candle's open/high/low/close in pixels, converts them to prices with the
 * user's two-point price-axis calibration, and sends the numbers as text.
 *
 * Assumes standard coloured candles (green/teal up, red down) on a plain
 * background, which covers the default look of most charting platforms.
 */

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major (ImageData.data). */
  data: Uint8ClampedArray | Uint8Array;
}

export interface PixelCandle {
  /** Column range of the candle, in pixels. */
  x0: number;
  x1: number;
  /** Rows (pixels, 0 = top). Higher price = smaller y. */
  highY: number;
  lowY: number;
  openY: number;
  closeY: number;
  bull: boolean;
}

export interface ExtractResult {
  candles: PixelCandle[];
  /** Typical body width in pixels. */
  bodyWidth: number;
  /** Why nothing usable was found, when candles is empty. */
  problem: string | null;
}

type Cls = 0 | 1 | 2; // 0 none, 1 bull, 2 bear

function hsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v: max / 255 };
}

function roughClass(r: number, g: number, b: number): Cls {
  const { h, s, v } = hsv(r, g, b);
  if (s < 0.3 || v < 0.25) return 0;
  if (h >= 75 && h <= 200) return 1; // green / teal
  if (h >= 330 || h <= 25) return 2; // red
  return 0;
}

const key = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * @param plotRight right edge of the candle area in pixels (exclusive) — pass
 *                  the price axis position so axis labels/tags are ignored.
 */
export function extractCandles(img: PixelImage, plotRight: number): ExtractResult {
  const { width: W, height: H, data } = img;
  const right = Math.max(1, Math.min(W, Math.floor(plotRight)));

  // 1. The dominant up and down colours (volume bars and text are usually lighter/blended).
  const counts: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < right; x++) {
      const i = (y * W + x) * 4;
      const c = roughClass(data[i]!, data[i + 1]!, data[i + 2]!);
      if (c) {
        const m = counts[c - 1]!;
        const k = key(data[i]!, data[i + 1]!, data[i + 2]!);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
  }
  const dominant = counts.map((m) => {
    let best = -1;
    let n = 0;
    for (const [k, v] of m) if (v > n) [best, n] = [k, v];
    return best < 0 ? null : { r: ((best >> 10) & 31) * 8 + 4, g: ((best >> 5) & 31) * 8 + 4, b: (best & 31) * 8 + 4, n };
  });
  if (!dominant[0] && !dominant[1]) {
    return { candles: [], bodyWidth: 0, problem: "No green/red candles found. Use a standard candlestick chart with coloured candles." };
  }
  const near = (i: number, d: { r: number; g: number; b: number } | null) =>
    !!d && Math.abs(data[i]! - d.r) + Math.abs(data[i + 1]! - d.g) + Math.abs(data[i + 2]! - d.b) <= 110;

  // 2. Per column: class and the longest vertical run of that class (a candle is one unbroken run).
  const colCls: Cls[] = new Array(right).fill(0);
  const colTop = new Array<number>(right).fill(-1);
  const colBot = new Array<number>(right).fill(-1);
  const mask = new Uint8Array(right * H); // 1 bull, 2 bear
  for (let x = 0; x < right; x++) {
    let bull = 0;
    let bear = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      if (near(i, dominant[0]!)) {
        mask[y * right + x] = 1;
        bull++;
      } else if (near(i, dominant[1]!)) {
        mask[y * right + x] = 2;
        bear++;
      }
    }
    // Runs are traced through same-hue pixels (thin anti-aliased wicks are faint), but a run
    // must contain at least one strong candle-colour pixel, so a semi-transparent volume bar
    // or text fringe never wins over a real candle. Columns with no strong pixel at all
    // (a 1-pixel doji blended into the background) fall back to hue alone.
    const hasStrong = bull + bear > 0;
    let best: { cls: Cls; len: number; top: number } = { cls: 0, len: 0, top: -1 };
    for (const cls of [1, 2] as const) {
      let run = 0;
      let strong = false;
      for (let y = 0; y <= H; y++) {
        let inRun = false;
        if (y < H) {
          const i = (y * W + x) * 4;
          const m = mask[y * right + x] === cls;
          inRun = m || roughClass(data[i]!, data[i + 1]!, data[i + 2]!) === cls;
          if (inRun && !m) mask[y * right + x] = cls; // faint pixel joins the candle's body test
          if (m) strong = true;
        }
        if (inRun) run++;
        else {
          if (run > best.len && (strong || !hasStrong)) best = { cls, len: run, top: y - run };
          run = 0;
          strong = false;
        }
      }
    }
    if (best.len >= 1) {
      colCls[x] = best.cls;
      colTop[x] = best.top;
      colBot[x] = best.top + best.len - 1;
    }
  }

  // 3. Group adjacent columns of the same class whose runs overlap into candles.
  const groups: { x0: number; x1: number; cls: Cls }[] = [];
  for (let x = 0; x < right; x++) {
    if (!colCls[x]) continue;
    const g = groups[groups.length - 1];
    if (g && g.x1 === x - 1 && g.cls === colCls[x] && colTop[x]! <= colBot[x - 1]! + 1 && colBot[x]! >= colTop[x - 1]! - 1) g.x1 = x;
    else groups.push({ x0: x, x1: x, cls: colCls[x]! });
  }
  if (groups.length < 5) {
    return { candles: [], bodyWidth: 0, problem: "Too few candles found. Make sure the screenshot shows a normal candlestick chart." };
  }

  // 4. Typical body width. Narrow slivers (a wick split off by anti-aliasing) join the
  //    candle right next to them; isolated slivers (text, drawings) are dropped.
  const widths = groups.map((g) => g.x1 - g.x0 + 1).sort((a, b) => a - b);
  const bodyWidth = widths[Math.floor(widths.length * 0.75)]!;
  const extent = (g: { x0: number; x1: number }) => {
    let top = Infinity;
    let bot = -Infinity;
    for (let x = g.x0; x <= g.x1; x++) {
      top = Math.min(top, colTop[x]!);
      bot = Math.max(bot, colBot[x]!);
    }
    return { top, bot };
  };
  const narrow = (g: { x0: number; x1: number }) => bodyWidth >= 4 && g.x1 - g.x0 + 1 < bodyWidth * 0.5;
  const merged: { x0: number; x1: number; cls: Cls; top: number; bot: number }[] = [];
  const wide = groups.filter((g) => !narrow(g)).map((g) => ({ ...g, ...extent(g) }));
  for (const g of groups.filter(narrow)) {
    const e = extent(g);
    const host = wide.find((w) => w.cls === g.cls && Math.min(Math.abs(w.x0 - g.x1), Math.abs(g.x0 - w.x1)) <= 2 && e.top <= w.bot + 2 && e.bot >= w.top - 2);
    if (host) {
      host.x0 = Math.min(host.x0, g.x0);
      host.x1 = Math.max(host.x1, g.x1);
      host.top = Math.min(host.top, e.top);
      host.bot = Math.max(host.bot, e.bot);
    }
  }
  merged.push(...wide.sort((a, b) => a.x0 - b.x0));

  const candles: PixelCandle[] = [];
  for (const g of merged) {
    const w = g.x1 - g.x0 + 1;
    if (w > Math.max(3, bodyWidth * 2.2)) continue;
    const highY = g.top;
    const lowY = g.bot;
    // Body rows: coloured across at least half of the candle's typical width.
    let bodyTop = -1;
    let bodyBot = -1;
    for (let y = highY; y <= lowY; y++) {
      let filled = 0;
      for (let x = g.x0; x <= g.x1; x++) if (mask[y * right + x] === g.cls) filled++;
      if (filled >= Math.max(1, Math.ceil(Math.min(w, bodyWidth) * 0.5))) {
        if (bodyTop < 0) bodyTop = y;
        bodyBot = y;
      }
    }
    if (bodyTop < 0) bodyTop = bodyBot = Math.round((highY + lowY) / 2);
    const bull = g.cls === 1;
    candles.push({ x0: g.x0, x1: g.x1, highY, lowY, openY: bull ? bodyBot : bodyTop, closeY: bull ? bodyTop : bodyBot, bull });
  }
  // The coloured current-price tag at the right edge breaks into pieces around its text;
  // those pieces share the same flat top and bottom, which real neighbouring candles almost never do.
  while (candles.length >= 2) {
    const a = candles[candles.length - 1]!;
    const b = candles[candles.length - 2]!;
    if (Math.abs(a.highY - b.highY) <= 1 && Math.abs(a.lowY - b.lowY) <= 1 && a.bull === b.bull && a.x0 - b.x1 <= bodyWidth) {
      candles.pop();
      // also drop the left piece if it is the start of the same tag
      const c = candles[candles.length - 2];
      if (!c || Math.abs(c.highY - b.highY) > 1 || Math.abs(c.lowY - b.lowY) > 1) {
        candles.pop();
        break;
      }
    } else break;
  }
  return { candles, bodyWidth, problem: candles.length < 5 ? "Too few candles could be read from this screenshot." : null };
}

export interface PriceCandle {
  /** Horizontal centre as a fraction of image width. */
  x: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Converts pixel candles to prices with a linear axis mapping (price -> y fraction known at two points). */
export function toPrices(
  candles: PixelCandle[],
  img: { width: number; height: number },
  cal: { y1: number; price1: number; y2: number; price2: number },
): { candles: PriceCandle[]; decimals: number } {
  const perFrac = (cal.price2 - cal.price1) / (cal.y2 - cal.y1);
  const price = (py: number) => cal.price1 + (py / img.height - cal.y1) * perFrac;
  const perPixel = Math.abs(perFrac / img.height);
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(perPixel || 1)) + 1));
  const r = (v: number) => Number(v.toFixed(decimals));
  return {
    decimals,
    candles: candles.map((k) => ({
      x: Number((((k.x0 + k.x1) / 2 + 0.5) / img.width).toFixed(4)),
      o: r(price(k.openY + 0.5)),
      h: r(price(k.highY)),
      l: r(price(k.lowY + 1)),
      c: r(price(k.closeY + 0.5)),
    })),
  };
}

/**
 * Finds where the price axis starts, from a tap on one of its labels: walk left
 * from the tap along the label's row until the label text ends, then step a
 * little further left. Falls back to just left of the tap.
 */
export function findAxisLeft(img: PixelImage, tapX: number, tapY: number): number {
  const { width: W, height: H, data } = img;
  const y0 = Math.max(0, Math.round(tapY) - 2);
  const y1 = Math.min(H - 1, Math.round(tapY) + 2);
  const x = Math.min(W - 1, Math.max(0, Math.round(tapX)));
  // Background: the most common colour on this row just left of the tap.
  const freq = new Map<number, number>();
  for (let xx = Math.max(0, x - Math.round(W * 0.2)); xx <= x; xx++) {
    const i = (Math.round(tapY) * W + xx) * 4;
    const k = key(data[i]!, data[i + 1]!, data[i + 2]!);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  let bgKey = 0;
  let best = 0;
  for (const [k, n] of freq) if (n > best) [bgKey, best] = [k, n];
  const bg = { r: ((bgKey >> 10) & 31) * 8 + 4, g: ((bgKey >> 5) & 31) * 8 + 4, b: (bgKey & 31) * 8 + 4 };
  const isInk = (xx: number) => {
    for (let y = y0; y <= y1; y++) {
      const i = (y * W + xx) * 4;
      if (Math.abs(data[i]! - bg.r) + Math.abs(data[i + 1]! - bg.g) + Math.abs(data[i + 2]! - bg.b) > 60) return true;
    }
    return false;
  };
  const maxGap = Math.max(4, Math.round(W * 0.006));
  let textLeft = x;
  let gap = 0;
  let sawInk = false;
  for (let xx = x; xx >= Math.max(0, x - Math.round(W * 0.15)); xx--) {
    if (isInk(xx)) {
      textLeft = xx;
      sawInk = true;
      gap = 0;
    } else if (sawInk && ++gap > maxGap) break;
  }
  return Math.max(0, textLeft - Math.round(W * 0.008));
}

/**
 * Snaps a finger tap on an axis label to the label text's vertical centre (axis
 * labels are centred on their price), so calibration doesn't depend on tap precision.
 * Returns the refined y in pixels, or the tap y if no label text is found nearby.
 */
export function snapToLabelCenter(img: PixelImage, tapX: number, tapY: number): number {
  const { width: W, height: H, data } = img;
  const xr0 = Math.max(0, Math.round(tapX - W * 0.015));
  const xr1 = Math.min(W - 1, Math.round(tapX + W * 0.015));
  const yr = Math.max(6, Math.round(H * 0.03));
  const ty = Math.round(tapY);
  // Background: the most common colour in the search window.
  const freq = new Map<number, number>();
  for (let y = Math.max(0, ty - yr); y <= Math.min(H - 1, ty + yr); y++)
    for (let x = xr0; x <= xr1; x++) {
      const i = (y * W + x) * 4;
      const k = key(data[i]!, data[i + 1]!, data[i + 2]!);
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  let bgKey = 0;
  let best = 0;
  for (const [k, n] of freq) if (n > best) [bgKey, best] = [k, n];
  const bg = { r: ((bgKey >> 10) & 31) * 8 + 4, g: ((bgKey >> 5) & 31) * 8 + 4, b: (bgKey & 31) * 8 + 4 };
  const inkRow = (y: number) => {
    let n = 0;
    for (let x = xr0; x <= xr1; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(data[i]! - bg.r) + Math.abs(data[i + 1]! - bg.g) + Math.abs(data[i + 2]! - bg.b) > 80) n++;
    }
    return n >= 2;
  };
  // Blocks of consecutive ink rows; pick the one containing or nearest to the tap.
  const blocks: [number, number][] = [];
  let start = -1;
  for (let y = Math.max(0, ty - yr); y <= Math.min(H - 1, ty + yr) + 1; y++) {
    const ink = y <= Math.min(H - 1, ty + yr) && inkRow(y);
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      blocks.push([start, y - 1]);
      start = -1;
    }
  }
  const textLike = blocks.filter(([a, b]) => b - a + 1 >= 3 && b - a + 1 <= H * 0.05);
  if (!textLike.length) return tapY;
  const dist = ([a, b]: [number, number]) => (ty < a ? a - ty : ty > b ? ty - b : 0);
  const [a, b] = textLike.sort((p, q) => dist(p) - dist(q))[0]!;
  return (a + b + 1) / 2;
}
