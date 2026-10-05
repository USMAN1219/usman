import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { extractCandles, findAxisLeft, snapToLabelCenter, toPrices } from "../shared/candles.ts";
import { CHART_H, CHART_SET, CHART_W, series } from "../e2e/generate-charts.ts";

// Fixture: the synthetic 15m chart (seed 37, 110 candles) used as the in-page example.
const png = PNG.sync.read(readFileSync("src/artifact/example-chart.png"));
const truth = series(37, 110, 0.25);
const cal = { y1: 0.1, price1: 110, y2: 0.9, price2: 100 }; // the generator's axis

describe("reading candles from a screenshot", () => {
  it("finds every candle and reads OHLC within a pixel or two", () => {
    expect(png.width).toBe(CHART_W);
    expect(png.height).toBe(CHART_H);
    expect(CHART_SET.find((c) => c.tf === "15m")?.n).toBe(110);
    const res = extractCandles(png, 0.9 * CHART_W - 2);
    expect(res.problem).toBeNull();
    expect(res.candles).toHaveLength(110);
    const { candles } = toPrices(res.candles, png, cal);
    const tol = (10 / (0.8 * CHART_H)) * 2.5; // ~2.5 px of price
    let worst = 0;
    candles.forEach((k, i) => {
      const t = truth[i]!;
      for (const [a, b] of [[k.h, t.h], [k.l, t.l], [k.o, t.o], [k.c, t.c]] as const) worst = Math.max(worst, Math.abs(a - b));
      if (Math.abs(t.c - t.o) > tol) expect(k.c > k.o).toBe(t.c > t.o); // direction is unmeasurable on 1-px dojis
    });
    expect(worst).toBeLessThan(tol);
    // Last close is the price shown on the chart's price tag (104.32).
    expect(candles.at(-1)!.c).toBeCloseTo(104.32, 1);
  });

  it("ignores the price-axis area and reports images without candles", () => {
    const blank = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(30) };
    expect(extractCandles(blank, 380).problem).toMatch(/No green\/red candles/);
  });
});

describe("plot edge near the price axis", () => {
  it("keeps the newest candle and rejects the coloured current-price tag", () => {
    // Even when cut through the axis labels and price tag, no extra candles appear.
    const res = extractCandles(png, 0.925 * CHART_W);
    expect(res.candles).toHaveLength(110);
    expect(toPrices(res.candles, png, cal).candles.at(-1)!.c).toBeCloseTo(104.32, 1);
  });
});

describe("finding the price axis from a tap on a label", () => {
  it("lands between the newest candle and the axis labels", () => {
    // Taps on the centres of the 110.00 and 101.00 labels.
    for (const fy of [0.1, 0.82]) {
      const left = findAxisLeft(png, 0.925 * CHART_W, fy * CHART_H);
      expect(left).toBeGreaterThan(1258); // newest candle ends at x=1258
      expect(left).toBeLessThanOrEqual(1265);
      expect(extractCandles(png, left).candles).toHaveLength(110);
    }
  });
});

describe("snapping a finger tap to the label centre", () => {
  it("finds the 110.00 and 101.00 labels' centres from imprecise taps", () => {
    // True price positions: 110 at y=80, 101 at y=656.
    for (const [tap, truthY] of [[72, 80], [88, 80], [648, 656], [664, 656]] as const) {
      const y = snapToLabelCenter(png, 0.925 * CHART_W, tap);
      expect(Math.abs(y - truthY)).toBeLessThanOrEqual(1.5);
    }
  });
});
