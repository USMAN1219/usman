import { describe, expect, it } from "vitest";
import { checkSetupLevels, computePositionSize, computeRiskReward, entryReference, gradeAtLeast } from "../shared/risk.ts";
import { mockAnalysis } from "../server/ai/mock.ts";
import type { Setup } from "../shared/analysis-schema.ts";

const base = (): Setup => structuredClone(mockAnalysis({ images: [], symbolHint: "TEST", notes: null }).setup);

describe("risk maths", () => {
  it("uses the entry-zone midpoint as the reference entry", () => {
    expect(entryReference({ entry_low: 101.4, entry_high: 101.8 })).toBeCloseTo(101.6);
    expect(entryReference({ entry_low: 50, entry_high: null })).toBe(50);
    expect(entryReference({ entry_low: null, entry_high: null })).toBeNull();
  });

  it("computes R multiples per target (example from the spec: risk 20, reward 60 = 1:3)", () => {
    const s = { ...base(), entry_low: 1000, entry_high: 1000, stop_loss: 980, tp1: 1040, tp2: 1060, tp3: null };
    const rr = computeRiskReward(s)!;
    expect(rr.riskPerUnit).toBe(20);
    expect(rr.tp1).toBe(2);
    expect(rr.tp2).toBe(3);
    expect(rr.primary).toBe(3);
  });

  it("handles shorts", () => {
    const s: Setup = { ...base(), direction: "short", entry_low: 1.105, entry_high: 1.106, stop_loss: 1.11, tp1: 1.095, tp2: null, tp3: null };
    const rr = computeRiskReward(s)!;
    expect(rr.primary).toBeCloseTo(2.33, 2); // (1.1055 - 1.095) / (1.11 - 1.1055)
  });

  it("rejects stops on the wrong side and unordered targets", () => {
    expect(checkSetupLevels({ ...base(), stop_loss: 102 }).ok).toBe(false);
    expect(checkSetupLevels({ ...base(), tp1: 100 }).ok).toBe(false);
    expect(checkSetupLevels({ ...base(), tp2: 105 }).problems.join()).toMatch(/ascending/);
    expect(checkSetupLevels({ ...base(), stop_loss: null }).problems.join()).toMatch(/stop loss/);
    expect(checkSetupLevels({ ...base(), direction: "short" }).ok).toBe(false);
  });

  it("never invents a position size when inputs are missing", () => {
    const rr = computeRiskReward(base());
    const r = computePositionSize(rr, { accountBalance: 10000, riskPercent: 1, pointValue: null, currency: "USD" });
    expect(r.available).toBe(false);
    expect(r.units).toBeNull();
    expect(r.note).toMatch(/value of a 1.0 price move/);
  });

  it("sizes positions from balance, risk % and point value", () => {
    const s = { ...base(), entry_low: 1000, entry_high: 1000, stop_loss: 980, tp1: 1040, tp2: null, tp3: null };
    const r = computePositionSize(computeRiskReward(s), { accountBalance: 10000, riskPercent: 1, pointValue: 5, currency: "USD" });
    // risk $100 / (20 points * $5) = 1 unit
    expect(r).toMatchObject({ available: true, riskAmount: 100, units: 1 });
  });

  it("orders grades", () => {
    expect(gradeAtLeast("A+", "B")).toBe(true);
    expect(gradeAtLeast("C", "B")).toBe(false);
    expect(gradeAtLeast("no_trade", "C")).toBe(false);
  });
});
