import { describe, expect, it } from "vitest";
import { applyGuardrails, complianceWarnings } from "../server/analysis/guardrails.ts";
import { mockAnalysis } from "../server/ai/mock.ts";
import { ChartAnalysisSchema, type ChartAnalysis } from "../shared/analysis-schema.ts";
import { DEFAULT_SETTINGS } from "../shared/types.ts";

const img = { data: new Uint8Array(), mime: "image/png" as const, label: "15m", width: 800, height: 500 };
const analysis = (notes: string | null = null): ChartAnalysis => mockAnalysis({ images: [img], symbolHint: "EURUSD", notes });
const run = (a: ChartAnalysis, settings = DEFAULT_SETTINGS, pointValue: number | null = null) => applyGuardrails({ analysis: a, settings, pointValue });

describe("guardrails", () => {
  it("mock output satisfies the strict schema", () => {
    expect(ChartAnalysisSchema.safeParse(analysis()).success).toBe(true);
    expect(ChartAnalysisSchema.safeParse(analysis("[mock:no-trade]")).success).toBe(true);
  });

  it("passes a consistent A-grade long", () => {
    const d = run(analysis());
    expect(d.finalDecision).toBe("potential_long");
    expect(d.grade).toBe("A");
    expect(d.rr?.primary).toBeGreaterThan(2);
    expect(d.meetsMinRr).toBe(true);
    expect(d.watchStatus).toBe("strong_setup");
    expect(d.guardrailNotes).toEqual([]);
  });

  it("downgrades a long whose stop is above entry", () => {
    const a = analysis();
    a.setup.stop_loss = 103;
    const d = run(a);
    expect(d.finalDecision).toBe("no_trade_wait");
    expect(d.direction).toBe("no_trade");
    expect(d.guardrailNotes.join()).toMatch(/stop loss at or above/);
  });

  it("downgrades a setup with no stop loss (never a setup without invalidation)", () => {
    const a = analysis();
    a.setup.stop_loss = null;
    expect(run(a).finalDecision).toBe("no_trade_wait");
  });

  it("downgrades when R:R is below the user's minimum but keeps levels for reference", () => {
    const d = run(analysis(), { ...DEFAULT_SETTINGS, minRr: 10 });
    expect(d.finalDecision).toBe("no_trade_wait");
    expect(d.direction).toBe("long");
    expect(d.meetsMinRr).toBe(false);
    expect(d.guardrailNotes.join()).toMatch(/below your minimum/);
    expect(d.watchStatus).toBe("watch");
  });

  it("downgrades when grade is below the user's minimum grade", () => {
    const d = run(analysis(), { ...DEFAULT_SETTINGS, minGrade: "A+" });
    expect(d.finalDecision).toBe("no_trade_wait");
    expect(d.meetsMinGrade).toBe(false);
  });

  it("refuses setups when no price scale is readable", () => {
    const a = analysis();
    a.charts.forEach((c) => (c.price_scale_readable = false));
    const d = run(a);
    expect(d.finalDecision).toBe("no_trade_wait");
    expect(d.guardrailNotes.join()).toMatch(/readable price scale/);
  });

  it("does not trust a final decision that contradicts the setup", () => {
    const a = analysis();
    a.final_decision = "potential_short";
    expect(run(a).finalDecision).toBe("no_trade_wait");
  });

  it("keeps NO TRADE as NO TRADE", () => {
    const d = run(analysis("[mock:no-trade]"));
    expect(d.finalDecision).toBe("no_trade_wait");
    expect(d.rr).toBeNull();
    expect(d.sizing.available).toBe(false);
  });

  it("computes position size only with a point value", () => {
    const settings = { ...DEFAULT_SETTINGS, accountBalance: 10000, riskPercent: 1 };
    expect(run(analysis(), settings, null).sizing.available).toBe(false);
    const d = run(analysis(), settings, 10);
    expect(d.sizing.available).toBe(true);
    expect(d.sizing.riskAmount).toBe(100);
    expect(d.sizing.units).toBeCloseTo(100 / (1.2 * 10), 3);
  });

  it("flags institution names, probability claims and indicator-based reasoning", () => {
    const a = analysis();
    a.participant_inference.institutional_style = "JPMorgan bought here.";
    a.summary = "There is a 92% chance this trade wins and it is guaranteed.";
    a.setup.why = "RSI oversold plus demand.";
    const w = complianceWarnings(a).join(" | ");
    expect(w).toMatch(/JPMorgan/);
    expect(w).toMatch(/probability/);
    expect(w).toMatch(/RSI/);
    expect(w).toMatch(/guaranteed/);
  });

  it("does not flag hedged language", () => {
    const a = analysis();
    a.summary = "Nothing is guaranteed; price may retest the FVG. RSI was visible on the chart but was ignored.";
    expect(complianceWarnings(a)).toEqual([]);
  });
});
