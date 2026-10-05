/**
 * Deterministic guardrails applied to every model response before the user
 * sees it. The model is good at reading charts; code is better at enforcing
 * rules. Anything that fails a rule is downgraded to NO TRADE - WAIT with an
 * explanation, never silently "fixed".
 */
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import { computePositionSize, computeRiskReward, checkSetupLevels, gradeAtLeast } from "../../shared/risk.ts";
import type { DerivedAnalysis, UserSettings, WatchStatus } from "../../shared/types.ts";

const INDICATOR_TERMS =
  /\b(RSI|MACD|moving averages?|EMA|SMA|bollinger|stochastic|CCI|supertrend|VWAP|ichimoku|ATR|fibonacci retracement indicator)\b/i;
const INSTITUTION_TERMS =
  /\b(JP ?Morgan|Goldman( Sachs)?|Morgan Stanley|Citadel|Citi(group|bank)?|Barclays|Deutsche Bank|HSBC|UBS|BlackRock|Bank of America)\b/i;
const PROBABILITY_TERMS = /\b\d{1,3}(\.\d+)?\s?%\s*(chance|probability|likely|win|success|certain)/i;
const GUARANTEE_TERMS = /(?<!\bnot |\bno |\bnever |\bnothing is )\b(guaranteed?|certain to|risk[- ]free|can'?t lose|sure (win|thing))\b/i;

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

/** Flags language the analysis is not allowed to rely on. Shown to the user as warnings. */
export function complianceWarnings(a: ChartAnalysis): string[] {
  const warnings: string[] = [];
  const all = collectStrings(a).join("\n");
  const decisionText = [a.setup.why, ...a.setup.confluence.filter((c) => c.present).map((c) => `${c.factor} ${c.note}`)].join("\n");
  const ind = decisionText.match(INDICATOR_TERMS);
  if (ind) warnings.push(`The setup reasoning mentions an indicator (${ind[0]}). This app's method excludes indicators - verify the price-action basis yourself.`);
  const inst = all.match(INSTITUTION_TERMS);
  if (inst) warnings.push(`The analysis names a specific institution (${inst[0]}). A chart cannot show who traded - treat this as unsupported.`);
  if (PROBABILITY_TERMS.test(all)) warnings.push("The analysis contains a probability-style claim. Confidence here is analytical, not a chance of profit.");
  const g = all.match(GUARANTEE_TERMS);
  if (g) warnings.push(`The analysis contains certainty language ("${g[0]}"). Nothing in trading is guaranteed.`);
  return warnings;
}

export function deriveWatchStatus(d: Pick<DerivedAnalysis, "finalDecision" | "direction" | "grade">, a: ChartAnalysis): WatchStatus {
  const potential = d.finalDecision !== "no_trade_wait";
  if (potential && (d.grade === "A+" || d.grade === "A") && !a.setup.requires_confirmation) return "strong_setup";
  if (potential) return "developing_setup";
  const hasDirectionalContext = a.bias === "bullish" || a.bias === "bearish";
  if (d.direction !== "no_trade" || (hasDirectionalContext && a.setup.wait_for.trim().length > 0 && a.market_condition !== "choppy"))
    return "watch";
  return "no_setup";
}

export interface GuardrailInput {
  analysis: ChartAnalysis;
  settings: UserSettings;
  pointValue: number | null;
}

export function applyGuardrails({ analysis, settings, pointValue }: GuardrailInput): DerivedAnalysis {
  const notes: string[] = [];
  const setup = analysis.setup;
  let direction = setup.direction;
  let grade = setup.grade;

  const readable = analysis.charts.some((c) => c.usable && c.price_scale_readable);
  if (direction !== "no_trade" && !readable) {
    notes.push("No screenshot has a readable price scale, so entry, stop and targets cannot be trusted.");
    direction = "no_trade";
  }

  if (direction !== "no_trade") {
    const check = checkSetupLevels(setup);
    if (!check.ok) {
      notes.push(...check.problems.map((p) => `Rejected: ${p}`));
      direction = "no_trade";
    }
  }
  if (direction !== "no_trade" && grade === "no_trade") {
    notes.push("The setup has a direction but no quality grade; treated as no trade.");
    direction = "no_trade";
  }
  if (direction === "no_trade") grade = "no_trade";

  const rr = direction === "no_trade" ? null : computeRiskReward(setup);
  const expected = direction === "long" ? "potential_long" : direction === "short" ? "potential_short" : "no_trade_wait";
  let finalDecision: DerivedAnalysis["finalDecision"] = expected;

  if (analysis.final_decision !== expected) {
    if (expected !== "no_trade_wait") {
      notes.push("The model's final decision did not match its own setup; defaulting to NO TRADE - WAIT.");
    }
    finalDecision = "no_trade_wait";
  }

  let meetsMinRr: boolean | null = null;
  if (rr?.primary != null) {
    meetsMinRr = rr.primary >= settings.minRr;
    if (!meetsMinRr && finalDecision !== "no_trade_wait") {
      notes.push(`Potential R:R of 1:${rr.primary} is below your minimum of 1:${settings.minRr}.`);
      finalDecision = "no_trade_wait";
    }
  }

  let meetsMinGrade: boolean | null = null;
  if (direction !== "no_trade") {
    meetsMinGrade = gradeAtLeast(grade, settings.minGrade);
    if (!meetsMinGrade && finalDecision !== "no_trade_wait") {
      notes.push(`Setup grade ${grade} is below your minimum grade of ${settings.minGrade}.`);
      finalDecision = "no_trade_wait";
    }
  }

  const sizing = computePositionSize(rr, {
    accountBalance: settings.accountBalance,
    riskPercent: settings.riskPercent,
    pointValue,
    currency: settings.accountCurrency,
  });

  const partial = { finalDecision, direction, grade };
  return {
    finalDecision,
    aiFinalDecision: analysis.final_decision,
    direction,
    grade,
    entryRef: rr?.entryRef ?? null,
    riskPerUnit: rr?.riskPerUnit ?? null,
    rr: rr ? { tp1: rr.tp1, tp2: rr.tp2, tp3: rr.tp3, primary: rr.primary } : null,
    meetsMinRr,
    meetsMinGrade,
    guardrailNotes: notes,
    complianceWarnings: complianceWarnings(analysis),
    sizing,
    watchStatus: deriveWatchStatus(partial, analysis),
    settingsUsed: { minRr: settings.minRr, minGrade: settings.minGrade },
  };
}
