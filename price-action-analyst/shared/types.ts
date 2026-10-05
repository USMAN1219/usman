/** API data-transfer types shared by the backend and the frontend. */
import type { ChartAnalysis, FinalDecision, Grade } from "./analysis-schema.ts";

export type AnalysisStatus = "queued" | "processing" | "completed" | "failed";
export type WatchStatus = "strong_setup" | "developing_setup" | "watch" | "no_setup";

export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  strong_setup: "Strong Setup",
  developing_setup: "Developing Setup",
  watch: "Watch",
  no_setup: "No Setup",
};

export interface StoredImage {
  key: string;
  label: string | null; // timeframe label supplied by the user
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

export interface SizingSnapshot {
  available: boolean;
  missing: string[];
  riskAmount: number | null;
  units: number | null;
  currency: string | null;
  note: string;
}

/** Deterministic post-processing results layered on top of the model output. */
export interface DerivedAnalysis {
  finalDecision: FinalDecision;
  aiFinalDecision: FinalDecision;
  direction: "long" | "short" | "no_trade";
  grade: Grade;
  entryRef: number | null;
  riskPerUnit: number | null;
  rr: { tp1: number | null; tp2: number | null; tp3: number | null; primary: number | null } | null;
  meetsMinRr: boolean | null;
  meetsMinGrade: boolean | null;
  guardrailNotes: string[];
  complianceWarnings: string[];
  sizing: SizingSnapshot;
  watchStatus: WatchStatus;
  settingsUsed: { minRr: number; minGrade: string };
}

export interface AnalysisUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number | null;
}

export interface AnalysisRecord {
  id: string;
  userId: string;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string | null;
  symbol: string | null;
  symbolHint: string | null;
  timeframes: string[];
  images: StoredImage[];
  notes: string | null;
  inputHash: string;
  result: ChartAnalysis | null;
  derived: DerivedAnalysis | null;
  error: string | null;
  usage: AnalysisUsage | null;
  taken: boolean;
  takenAt: string | null;
  outcomePnl: number | null;
  outcomeNote: string | null;
}

/** Compact row for lists. */
export interface AnalysisSummary {
  id: string;
  status: AnalysisStatus;
  createdAt: string;
  symbol: string | null;
  timeframes: string[];
  finalDecision: FinalDecision | null;
  direction: "long" | "short" | "no_trade" | null;
  grade: Grade | null;
  confidence: "high" | "medium" | "low" | null;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  rr: number | null;
  thumbnailKey: string | null;
  taken: boolean;
  outcomePnl: number | null;
  costUsd: number | null;
}

export interface AlertPreferences {
  enabled: boolean;
  aSetup: boolean;
  approachingLevel: boolean;
  approachingThresholdPercent: number;
  liquiditySweep: boolean;
  breakoutRetest: boolean;
  setupInvalidated: boolean;
  browserNotifications: boolean;
}

export interface UserSettings {
  accountBalance: number | null;
  accountCurrency: string;
  riskPercent: number;
  maxDailyLossPercent: number;
  maxTradesPerDay: number;
  minRr: number;
  minGrade: "A+" | "A" | "B" | "C";
  alerts: AlertPreferences;
}

export const DEFAULT_SETTINGS: UserSettings = {
  accountBalance: null,
  accountCurrency: "USD",
  riskPercent: 1,
  maxDailyLossPercent: 3,
  maxTradesPerDay: 3,
  minRr: 2,
  minGrade: "B",
  alerts: {
    enabled: false,
    aSetup: true,
    approachingLevel: true,
    approachingThresholdPercent: 0.3,
    liquiditySweep: true,
    breakoutRetest: true,
    setupInvalidated: true,
    browserNotifications: false,
  },
};

export interface WatchlistItem {
  id: string;
  symbol: string;
  notes: string | null;
  pointValue: number | null;
  statusOverride: WatchStatus | null;
  createdAt: string;
  /** Derived from the most recent completed analysis for this symbol. */
  latest: {
    analysisId: string;
    createdAt: string;
    status: WatchStatus;
    finalDecision: FinalDecision | null;
    grade: Grade | null;
  } | null;
  effectiveStatus: WatchStatus;
}

export type NotificationKind =
  | "a_setup"
  | "approaching_level"
  | "liquidity_sweep"
  | "breakout_retest"
  | "setup_invalidated";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  analysisId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface DailyRiskStatus {
  date: string;
  tradesTaken: number;
  maxTrades: number;
  realisedPnl: number;
  maxDailyLoss: number | null; // in account currency when balance known
  tradeLimitReached: boolean;
  lossLimitReached: boolean;
}

export interface UsageSummary {
  monthStart: string;
  analysesThisMonth: number;
  costThisMonthUsd: number;
  inputTokens: number;
  outputTokens: number;
  analysesToday: number;
  limits: { perHour: number; perDay: number; monthlyBudgetUsd: number | null };
}

export interface PublicUser {
  id: string;
  email: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Canonical symbol form used for storage and matching: upper case, exchange
 * prefix dropped ("OANDA:EURUSD" -> "EURUSD"), separators removed ("EUR/USD" -> "EURUSD").
 */
export function normalizeSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().split(":").pop()!.replace(/[^A-Z0-9._!-]/g, "").slice(0, 32);
  return s || null;
}
