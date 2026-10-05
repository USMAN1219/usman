/**
 * Deterministic risk maths. Never delegated to the AI: the model proposes
 * levels, this module checks them and does the arithmetic.
 */
import type { Setup } from "./analysis-schema.ts";

export interface LevelCheck {
  ok: boolean;
  problems: string[];
}

export interface RiskReward {
  entryRef: number;
  riskPerUnit: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  /** R multiple to the primary target (TP2 when present, otherwise TP1). */
  primary: number | null;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Reference entry price: midpoint of the entry zone (or the single price). */
export function entryReference(setup: Pick<Setup, "entry_low" | "entry_high">): number | null {
  const { entry_low: lo, entry_high: hi } = setup;
  if (lo == null && hi == null) return null;
  if (lo == null) return hi;
  if (hi == null) return lo;
  return (Math.min(lo, hi) + Math.max(lo, hi)) / 2;
}

/**
 * Validates that a directional setup is internally consistent: it must have an
 * entry, a stop on the correct side, and at least TP1 on the correct side, with
 * targets ordered away from entry.
 */
export function checkSetupLevels(setup: Setup): LevelCheck {
  const problems: string[] = [];
  if (setup.direction === "no_trade") return { ok: true, problems };

  const isLong = setup.direction === "long";
  const lo = setup.entry_low ?? setup.entry_high;
  const hi = setup.entry_high ?? setup.entry_low;
  if (lo == null || hi == null) problems.push("No entry price or zone could be determined.");
  if (setup.stop_loss == null) problems.push("No stop loss / invalidation price was provided.");
  if (setup.tp1 == null) problems.push("No first target (TP1) was provided.");
  if (problems.length) return { ok: false, problems };

  const entryLow = Math.min(lo!, hi!);
  const entryHigh = Math.max(lo!, hi!);
  const sl = setup.stop_loss!;
  const targets = [setup.tp1, setup.tp2, setup.tp3].filter((t): t is number => t != null);

  for (const v of [entryLow, entryHigh, sl, ...targets]) {
    if (!Number.isFinite(v) || v <= 0) {
      problems.push("One or more prices are not valid positive numbers.");
      return { ok: false, problems };
    }
  }

  if (isLong) {
    if (!(sl < entryLow)) problems.push("Long setup has its stop loss at or above the entry.");
    if (!(targets[0]! > entryHigh)) problems.push("Long setup has TP1 at or below the entry.");
    for (let i = 1; i < targets.length; i++) {
      if (!(targets[i]! > targets[i - 1]!)) problems.push(`Long targets are not in ascending order (TP${i + 1}).`);
    }
  } else {
    if (!(sl > entryHigh)) problems.push("Short setup has its stop loss at or below the entry.");
    if (!(targets[0]! < entryLow)) problems.push("Short setup has TP1 at or above the entry.");
    for (let i = 1; i < targets.length; i++) {
      if (!(targets[i]! < targets[i - 1]!)) problems.push(`Short targets are not in descending order (TP${i + 1}).`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** R multiples per target, measured from the entry-zone midpoint. Null if levels are unusable. */
export function computeRiskReward(setup: Setup): RiskReward | null {
  if (setup.direction === "no_trade") return null;
  if (!checkSetupLevels(setup).ok) return null;
  const entryRef = entryReference(setup)!;
  const risk = Math.abs(entryRef - setup.stop_loss!);
  if (risk <= 0) return null;
  const r = (tp: number | null) => (tp == null ? null : round(Math.abs(tp - entryRef) / risk));
  const tp1 = r(setup.tp1);
  const tp2 = r(setup.tp2);
  const tp3 = r(setup.tp3);
  return { entryRef, riskPerUnit: risk, tp1, tp2, tp3, primary: tp2 ?? tp1 };
}

export interface SizingInput {
  accountBalance: number | null;
  riskPercent: number | null;
  /** Account-currency value of a 1.0 price move for one unit/lot/contract. */
  pointValue: number | null;
  currency: string | null;
}

export interface SizingResult {
  available: boolean;
  missing: string[];
  riskAmount: number | null;
  units: number | null;
  currency: string | null;
  note: string;
}

/**
 * Approximate position size = (balance x risk%) / (stop distance x value per point).
 * Refuses to guess: any missing input is reported instead of invented.
 */
export function computePositionSize(rr: RiskReward | null, input: SizingInput): SizingResult {
  const missing: string[] = [];
  if (!rr) missing.push("a valid entry and stop loss");
  if (input.accountBalance == null || !(input.accountBalance > 0)) missing.push("account balance");
  if (input.riskPercent == null || !(input.riskPercent > 0)) missing.push("risk percentage per trade");
  if (input.pointValue == null || !(input.pointValue > 0))
    missing.push("value of a 1.0 price move per unit/lot/contract for this instrument (set it on the watchlist)");

  if (missing.length) {
    return {
      available: false,
      missing,
      riskAmount: null,
      units: null,
      currency: input.currency,
      note: `Position size not calculated. Needed: ${missing.join(", ")}.`,
    };
  }

  const riskAmount = round((input.accountBalance! * input.riskPercent!) / 100, 2);
  const units = round(riskAmount / (rr!.riskPerUnit * input.pointValue!), 4);
  return {
    available: true,
    missing,
    riskAmount,
    units,
    currency: input.currency,
    note:
      "Approximate size only. Check your broker's contract size, minimum lot step, spread and commission before placing any order.",
  };
}

export const GRADE_ORDER = ["no_trade", "C", "B", "A", "A+"] as const;

export function gradeAtLeast(grade: string, minimum: string): boolean {
  const g = GRADE_ORDER.indexOf(grade as (typeof GRADE_ORDER)[number]);
  const m = GRADE_ORDER.indexOf(minimum as (typeof GRADE_ORDER)[number]);
  if (g < 0 || m < 0) return false;
  return g >= m;
}
