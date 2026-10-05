import type { FinalDecision } from "../../shared/analysis-schema.ts";

export const fmtPrice = (p: number | null | undefined) => {
  if (p == null) return "—";
  const a = Math.abs(p);
  return a >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : a >= 1 ? p.toFixed(a >= 100 ? 2 : 4).replace(/0+$/, "").replace(/\.$/, "") : p.toPrecision(5);
};

export const fmtRange = (lo: number | null | undefined, hi: number | null | undefined) =>
  lo == null && hi == null ? "—" : lo == null || hi == null || lo === hi ? fmtPrice(lo ?? hi) : `${fmtPrice(Math.min(lo, hi))} – ${fmtPrice(Math.max(lo, hi))}`;

export const fmtRr = (r: number | null | undefined) => (r == null ? "—" : `1:${r.toFixed(2).replace(/\.?0+$/, "")}`);

export const fmtMoney = (v: number | null | undefined, currency = "USD") =>
  v == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(v);

export const fmtUsd = (v: number | null | undefined) => (v == null ? "—" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const DECISION_LABEL: Record<FinalDecision, string> = {
  potential_long: "🟢 POTENTIAL LONG",
  potential_short: "🔴 POTENTIAL SHORT",
  no_trade_wait: "⚪ NO TRADE — WAIT",
};

export const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function localMidnightIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
