/**
 * Generates synthetic candlestick chart screenshots (PNG) for testing:
 *   npm run charts:generate            -> e2e/output/charts/*.png
 *
 * The price axis is fixed (110 at 10% of the height, 100 at 90%; plot area
 * 2%-90% of the width) so automated tests can check annotation placement.
 * The price path tells a simple story: an uptrend, a pullback that sweeps a
 * prior low near 100.9, then a sharp bullish recovery.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export const CHART_W = 1400;
export const CHART_H = 800;
const PRICE_TOP = 110;
const PRICE_BOTTOM = 100;
const yOf = (p: number) => (0.1 + ((PRICE_TOP - p) / (PRICE_TOP - PRICE_BOTTOM)) * 0.8) * CHART_H;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export function series(seed: number, n: number, noise: number): Candle[] {
  const r = rng(seed);
  // Anchor path: rally to 108.6, pull back, sweep 100.9, recover to ~104.2.
  const anchors = [
    [0, 102.5], [0.22, 105.5], [0.38, 108.6], [0.47, 106.2], [0.55, 108.5], [0.66, 103.0],
    [0.74, 101.2], [0.8, 100.7], [0.84, 102.8], [0.92, 103.6], [1, 104.2],
  ];
  const at = (t: number) => {
    for (let i = 1; i < anchors.length; i++) {
      const [t1, p1] = anchors[i]! as [number, number];
      const [t0, p0] = anchors[i - 1]! as [number, number];
      if (t <= t1) return p0 + ((t - t0) / (t1 - t0)) * (p1 - p0);
    }
    return anchors.at(-1)![1]!;
  };
  const out: Candle[] = [];
  let prev = at(0);
  for (let i = 0; i < n; i++) {
    const target = at((i + 1) / n);
    const o = prev;
    const c = target + (r() - 0.5) * noise;
    const h = Math.max(o, c) + r() * noise * 0.8;
    const l = Math.min(o, c) - r() * noise * 0.8;
    out.push({ o, h: Math.min(h, 109.6), l: Math.max(l, 100.25), c });
    prev = c;
  }
  return out;
}

function chartHtml(symbol: string, tf: string, candles: Candle[]): string {
  const left = 0.02 * CHART_W;
  const right = 0.9 * CHART_W;
  const step = (right - left) / candles.length;
  const body = candles
    .map((k, i) => {
      const x = left + i * step + step / 2;
      const up = k.c >= k.o;
      const color = up ? "#26a69a" : "#ef5350";
      const top = yOf(Math.max(k.o, k.c));
      const bh = Math.max(1, yOf(Math.min(k.o, k.c)) - top);
      return `<line x1="${x}" x2="${x}" y1="${yOf(k.h)}" y2="${yOf(k.l)}" stroke="${color}" stroke-width="1.2"/><rect x="${x - step * 0.35}" y="${top}" width="${step * 0.7}" height="${bh}" fill="${color}"/>`;
    })
    .join("");
  const grid = Array.from({ length: 11 }, (_, i) => PRICE_BOTTOM + i)
    .map((p) => `<line x1="0" x2="${right}" y1="${yOf(p)}" y2="${yOf(p)}" stroke="#2a2e39" stroke-width="1"/><text x="${right + 12}" y="${yOf(p) + 5}" fill="#b2b5be" font-size="15" font-family="Arial">${p.toFixed(2)}</text>`)
    .join("");
  const last = candles.at(-1)!.c;
  return `<!doctype html><html><body style="margin:0;background:#131722">
<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W}" height="${CHART_H}" style="display:block">
<rect width="100%" height="100%" fill="#131722"/>${grid}
<line x1="${right}" x2="${right}" y1="0" y2="${CHART_H}" stroke="#363a45"/>
${body}
<rect x="${right + 2}" y="${yOf(last) - 12}" width="${CHART_W - right - 4}" height="24" fill="#26a69a"/>
<text x="${right + 12}" y="${yOf(last) + 5}" fill="#fff" font-size="15" font-family="Arial">${last.toFixed(2)}</text>
<text x="16" y="30" fill="#d1d4dc" font-size="20" font-family="Arial" font-weight="bold">${symbol} · ${tf}</text>
</svg></body></html>`;
}

export const CHART_SET = [
  { tf: "4h", seed: 11, n: 70, noise: 0.5 },
  { tf: "1h", seed: 23, n: 90, noise: 0.35 },
  { tf: "15m", seed: 37, n: 110, noise: 0.25 },
];

export async function generateCharts(outDir: string, symbol = "TESTUSD", browser?: Browser): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const own = !browser;
  const b = browser ?? (await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" }));
  const page = await b.newPage({ viewport: { width: CHART_W, height: CHART_H } });
  const files: string[] = [];
  for (const c of CHART_SET) {
    await page.setContent(chartHtml(symbol, c.tf.toUpperCase(), series(c.seed, c.n, c.noise)));
    const file = path.join(outDir, `${symbol}_${c.tf}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  await page.close();
  if (own) await b.close();
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await generateCharts(path.resolve("e2e/output/charts"));
  console.log(files.join("\n"));
}
