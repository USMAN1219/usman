/**
 * Optional alerts, evaluated whenever a new analysis completes.
 *
 * The app has no live price feed (it analyses screenshots), so alerts are
 * based on what each new screenshot shows: the current price read from it,
 * compared with levels from this and the previous analysis of the same symbol.
 */
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import type { AlertPreferences, AnalysisRecord, DerivedAnalysis, NotificationKind } from "../../shared/types.ts";

export interface AlertDraft {
  kind: NotificationKind;
  title: string;
  body: string;
}

const pct = (a: number, b: number) => (Math.abs(a - b) / Math.abs(b)) * 100;

export function evaluateAlerts(args: {
  prefs: AlertPreferences;
  symbol: string | null;
  analysis: ChartAnalysis;
  derived: DerivedAnalysis;
  previous: AnalysisRecord | null;
}): AlertDraft[] {
  const { prefs, analysis, derived, previous } = args;
  if (!prefs.enabled) return [];
  const sym = args.symbol ?? "Chart";
  const out: AlertDraft[] = [];
  const price = analysis.current_price;

  if (prefs.aSetup && derived.finalDecision !== "no_trade_wait" && (derived.grade === "A" || derived.grade === "A+")) {
    out.push({
      kind: "a_setup",
      title: `${sym}: potential ${derived.direction.toUpperCase()} (${derived.grade})`,
      body: `${analysis.setup.requires_confirmation ? "Needs confirmation: " + analysis.setup.wait_for : analysis.summary}`.slice(0, 400),
    });
  }

  if (prefs.liquiditySweep && analysis.liquidity.sweeps.length) {
    const s = analysis.liquidity.sweeps[0]!;
    out.push({
      kind: "liquidity_sweep",
      title: `${sym}: ${s.side === "buy_side" ? "buy-side" : "sell-side"} liquidity sweep at ${s.price}`,
      body: s.description.slice(0, 400),
    });
  }

  if (prefs.breakoutRetest && (analysis.breakout.classification === "real" || analysis.setup.entry_type === "retest")) {
    out.push({
      kind: "breakout_retest",
      title: `${sym}: breakout/retest developing`,
      body: `${analysis.breakout.evidence} ${analysis.retest}`.trim().slice(0, 400),
    });
  }

  if (prefs.approachingLevel && price != null && price > 0) {
    const candidates: { label: string; price: number }[] = [
      ...analysis.levels.filter((l) => l.importance === "major").map((l) => ({ label: `${l.kind} ${l.price}`, price: l.price })),
      ...analysis.zones
        .filter((z) => z.grade === "A" || z.grade === "A+")
        .map((z) => ({ label: `${z.kind} zone ${z.price_low}-${z.price_high}`, price: price > z.price_high ? z.price_high : z.price_low })),
    ];
    if (derived.direction !== "no_trade" && analysis.setup.entry_low != null)
      candidates.push({ label: `entry zone`, price: price > (analysis.setup.entry_high ?? analysis.setup.entry_low) ? (analysis.setup.entry_high ?? analysis.setup.entry_low) : analysis.setup.entry_low });
    const near = candidates
      .map((c) => ({ ...c, dist: pct(price, c.price) }))
      .filter((c) => c.dist > 0 && c.dist <= prefs.approachingThresholdPercent)
      .sort((a, b) => a.dist - b.dist)[0];
    if (near) {
      out.push({
        kind: "approaching_level",
        title: `${sym}: price ${price} is ${near.dist.toFixed(2)}% from ${near.label}`,
        body: "Price in the latest screenshot is close to an important level. Re-check the chart before acting.",
      });
    }
  }

  if (prefs.setupInvalidated && previous?.derived && previous.result && price != null) {
    const prev = previous.result.setup;
    const prevPotential = previous.derived.finalDecision !== "no_trade_wait";
    if (prevPotential && prev.stop_loss != null) {
      const broken = previous.derived.direction === "long" ? price <= prev.stop_loss : price >= prev.stop_loss;
      if (broken) {
        out.push({
          kind: "setup_invalidated",
          title: `${sym}: earlier ${previous.derived.direction.toUpperCase()} idea invalidated`,
          body: `Current price ${price} is beyond the earlier stop/invalidation at ${prev.stop_loss} (analysis from ${previous.createdAt.slice(0, 16).replace("T", " ")} UTC).`,
        });
      }
    }
  }
  return out;
}
