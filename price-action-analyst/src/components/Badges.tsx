import type { FinalDecision } from "../../shared/analysis-schema.ts";
import { WATCH_STATUS_LABELS, type WatchStatus } from "../../shared/types.ts";
import { DECISION_LABEL } from "../lib/format.ts";

export function DecisionBadge({ decision, large = false }: { decision: FinalDecision | null; large?: boolean }) {
  if (!decision) return <span className="badge neutral">Pending</span>;
  const cls = decision === "potential_long" ? "long" : decision === "potential_short" ? "short" : "wait";
  return <span className={`badge ${cls}${large ? " large" : ""}`}>{DECISION_LABEL[decision]}</span>;
}

export function GradeBadge({ grade }: { grade: string | null }) {
  if (!grade) return null;
  const label = grade === "no_trade" ? "NO TRADE" : grade;
  const cls = grade === "A+" ? "g-aplus" : grade === "A" ? "g-a" : grade === "B" ? "g-b" : grade === "C" ? "g-c" : "g-none";
  return <span className={`badge grade ${cls}`}>{label}</span>;
}

export function WatchBadge({ status }: { status: WatchStatus }) {
  return <span className={`badge watch-${status}`}>{WATCH_STATUS_LABELS[status]}</span>;
}

export function ConfidenceBadge({ confidence }: { confidence: "high" | "medium" | "low" | null | undefined }) {
  if (!confidence) return null;
  return (
    <span className={`badge conf-${confidence}`} title="Analytical confidence in the evidence — NOT a probability of profit.">
      {confidence[0]!.toUpperCase() + confidence.slice(1)} confidence
    </span>
  );
}
