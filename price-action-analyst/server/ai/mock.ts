/**
 * Deterministic stand-in for the vision model, for automated tests and
 * offline UI development only. It does NOT look at the image. Refused in
 * production by config validation, and every result says MOCK.
 *
 * Its calibration matches the synthetic charts produced by e2e/generate-charts.ts
 * (price 110 at 10% of image height, 100 at 90%).
 */
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import type { AnalyzerInput, AnalyzerOutput, ChartAnalyzer } from "./analyzer.ts";

export function mockAnalysis(input: Pick<AnalyzerInput, "images" | "symbolHint" | "notes">): ChartAnalysis {
  const noTrade = input.notes?.includes("[mock:no-trade]") ?? false;
  const labels = input.images.map((i, idx) => i.label ?? `image ${idx}`);
  const last = input.images.length - 1;
  return {
    charts: input.images.map((img, idx) => ({
      image_index: idx,
      detected_symbol: input.symbolHint,
      detected_timeframe: img.label,
      timeframe_source: img.label ? "user_label" : "unknown",
      price_scale_readable: true,
      current_price: 104.2,
      usable: true,
      issues: [],
    })),
    same_instrument: true,
    readability_issues: ["MOCK ANALYSIS - generated without looking at the image. For testing only."],
    symbol: input.symbolHint ?? "MOCK",
    current_price: 104.2,
    timeframes: labels,
    market_condition: noTrade ? "choppy" : "transitional",
    bias: noTrade ? "unclear" : "bullish",
    htf_structure: {
      summary: "MOCK: Higher-timeframe structure bullish (HH/HL); lower timeframe retraced into demand.",
      swing_points: "MOCK: Swing high 108.6, protected swing low 100.6.",
      timeframe_relationships: "MOCK: HTF bullish context; LTF swept sell-side liquidity then shifted bullish.",
    },
    levels: [
      { kind: "resistance", price: 108.6, price_high: null, timeframe: labels[0] ?? null, importance: "major", reason: "MOCK: prior swing high with two rejections.", image_index: null, x_start: 0.35 },
      { kind: "support", price: 102.0, price_high: null, timeframe: labels[0] ?? null, importance: "major", reason: "MOCK: former resistance turned support.", image_index: null, x_start: 0.2 },
    ],
    levels_explanation: "MOCK: Levels chosen for multiple reactions and breakout history.",
    liquidity: {
      pools: [
        { price: 108.6, type: "equal_highs", scope: "external", status: "untaken", description: "MOCK: equal highs - buy-side liquidity target.", timeframe: labels[0] ?? null, image_index: null },
        { price: 100.9, type: "previous_low", scope: "internal", status: "swept", description: "MOCK: previous low swept.", timeframe: labels[last] ?? null, image_index: null },
      ],
      sweeps: noTrade
        ? []
        : [{ side: "sell_side", price: 100.9, timeframe: labels[last] ?? null, rejection_strength: "strong", description: "MOCK: sell-side sweep with strong rejection.", image_index: last, x: 0.7 }],
      summary: "MOCK: Sell-side liquidity taken; buy-side liquidity above 108.6 remains.",
    },
    structure: {
      events: noTrade
        ? []
        : [{ type: "CHOCH", direction: "bullish", level_price: 103.0, timeframe: labels[last] ?? null, strength: "strong", displacement: true, after_liquidity_event: true, description: "MOCK: bullish CHOCH after sweep.", image_index: last, x: 0.78 }],
      shift_summary: "MOCK: LTF shifted bullish after sweep.",
    },
    zones: [
      { kind: "demand", price_low: 101.0, price_high: 101.8, timeframe: labels[last] ?? null, grade: "A", fresh: true, reason: "MOCK: origin of displacement.", image_index: null, x_start: 0.7 },
    ],
    fvgs: [
      { direction: "bullish", price_low: 102.4, price_high: 103.1, timeframe: labels[last] ?? null, status: "fresh", context: "MOCK: created by CHOCH displacement.", image_index: null, x_start: 0.76 },
    ],
    order_blocks: [],
    order_block_note: "MOCK: No high-quality order block identified.",
    displacement: "MOCK: Strong bullish displacement after the sweep.",
    breakout: { classification: "unconfirmed", level_price: 104.5, evidence: "MOCK: No acceptance above 104.5 yet." },
    retest: "MOCK: Price may retest the FVG / demand before continuation.",
    participant_inference: {
      institutional_style: "MOCK: Displacement after the sweep suggests institutional-style buying pressure may be present (inference only).",
      retail_behaviour: "MOCK: Breakdown sellers below 100.9 may have been trapped (chart-based inference).",
    },
    setup: noTrade
      ? {
          direction: "no_trade", entry_type: null, entry_low: null, entry_high: null, stop_loss: null, tp1: null, tp2: null, tp3: null,
          stop_reason: null, target_reasons: [], grade: "no_trade", confidence: "low", trade_style: null, requires_confirmation: false,
          confluence: [], why: "MOCK: No clean setup.", invalidation: "MOCK: n/a", wait_for: "MOCK: Wait for clear structure.",
          no_trade_reasons: ["Choppy structure"],
        }
      : {
          direction: "long", entry_type: "limit", entry_low: 101.4, entry_high: 101.8, stop_loss: 100.4, tp1: 106.0, tp2: 108.5, tp3: null,
          stop_reason: "MOCK: below the swept low / protected swing.", target_reasons: ["MOCK: TP1 internal high", "MOCK: TP2 equal highs"],
          grade: "A", confidence: "medium", trade_style: "intraday", requires_confirmation: false,
          confluence: [
            { factor: "Higher-timeframe alignment", present: true, note: "MOCK" },
            { factor: "Liquidity swept", present: true, note: "MOCK" },
            { factor: "Displacement + CHOCH", present: true, note: "MOCK" },
            { factor: "Fresh demand", present: true, note: "MOCK" },
          ],
          why: "MOCK: Sweep + CHOCH + fresh demand inside bullish HTF structure.",
          invalidation: "MOCK: A close below 100.4 breaks the protected low and invalidates the idea.",
          wait_for: "MOCK: Limit order in demand; no further confirmation required.",
          no_trade_reasons: [],
        },
    calibrations: input.images.map((_, idx) => ({
      image_index: idx, y1: 0.1, price1: 110, y2: 0.9, price2: 100, plot_left: 0.02, plot_right: 0.9, scale: "linear", confidence: "high",
    })),
    final_decision: noTrade ? "no_trade_wait" : "potential_long",
    summary: noTrade ? "MOCK: No trade - wait." : "MOCK: Potential long from demand after a sell-side sweep.",
  };
}

export class MockChartAnalyzer implements ChartAnalyzer {
  constructor(private readonly delayMs = 0) {}
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      analysis: mockAnalysis(input),
      usage: { model: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: this.delayMs },
    };
  }
}
