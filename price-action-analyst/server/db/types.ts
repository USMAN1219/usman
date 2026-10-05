/**
 * Persistence interface. Two implementations exist: PostgreSQL for
 * production and an in-memory one for tests and zero-setup local development.
 * Every query is scoped by userId so one user can never read another's data.
 */
import type {
  AnalysisRecord,
  AnalysisStatus,
  AnalysisSummary,
  AppNotification,
  NotificationKind,
  StoredImage,
  UserSettings,
  WatchStatus,
} from "../../shared/types.ts";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface NewAnalysis {
  id: string;
  userId: string;
  symbolHint: string | null;
  timeframes: string[];
  images: StoredImage[];
  notes: string | null;
  inputHash: string;
}

export type AnalysisCompletion = Pick<AnalysisRecord, "result" | "derived" | "symbol" | "timeframes" | "usage">;

export interface AnalysisFilter {
  symbol?: string;
  direction?: "long" | "short" | "no_trade";
  grade?: string;
  limit: number;
  offset: number;
}

export interface WatchlistRow {
  id: string;
  userId: string;
  symbol: string;
  notes: string | null;
  pointValue: number | null;
  statusOverride: WatchStatus | null;
  createdAt: string;
}

export interface UsageTotals {
  analyses: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Repository {
  // users
  createUser(user: { id: string; email: string; passwordHash: string }): Promise<UserRow>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;

  // settings
  getSettings(userId: string): Promise<UserSettings | null>;
  saveSettings(userId: string, settings: UserSettings): Promise<void>;

  // analyses
  createAnalysis(a: NewAnalysis): Promise<AnalysisRecord>;
  getAnalysis(userId: string, id: string): Promise<AnalysisRecord | null>;
  /** Job runner access by id only; used by the background worker after it authenticates. */
  getAnalysisForJob(id: string): Promise<AnalysisRecord | null>;
  /** Atomically moves queued -> processing. Returns false if another worker already claimed it. */
  claimAnalysis(id: string): Promise<boolean>;
  setAnalysisStatus(id: string, status: AnalysisStatus, error?: string | null): Promise<void>;
  completeAnalysis(id: string, data: AnalysisCompletion): Promise<void>;
  listAnalyses(userId: string, filter: AnalysisFilter): Promise<{ items: AnalysisSummary[]; total: number }>;
  findRecentByHash(userId: string, inputHash: string, sinceIso: string): Promise<AnalysisRecord | null>;
  latestCompletedForSymbol(userId: string, symbol: string, excludeId?: string): Promise<AnalysisRecord | null>;
  deleteAnalysis(userId: string, id: string): Promise<AnalysisRecord | null>;
  setOutcome(
    userId: string,
    id: string,
    o: { taken: boolean; outcomePnl: number | null; outcomeNote: string | null },
  ): Promise<AnalysisRecord | null>;
  takenSince(userId: string, sinceIso: string): Promise<{ count: number; pnl: number }>;
  usageSince(userId: string | null, sinceIso: string): Promise<UsageTotals>;
  countAnalysesSince(userId: string, sinceIso: string): Promise<number>;

  // watchlist
  listWatchlist(userId: string): Promise<WatchlistRow[]>;
  addWatchlist(row: Omit<WatchlistRow, "createdAt">): Promise<WatchlistRow>;
  updateWatchlist(
    userId: string,
    id: string,
    patch: Partial<Pick<WatchlistRow, "notes" | "pointValue" | "statusOverride">>,
  ): Promise<WatchlistRow | null>;
  deleteWatchlist(userId: string, id: string): Promise<boolean>;
  findWatchlistBySymbol(userId: string, symbol: string): Promise<WatchlistRow | null>;

  // notifications
  addNotification(n: {
    id: string;
    userId: string;
    analysisId: string | null;
    kind: NotificationKind;
    title: string;
    body: string;
  }): Promise<void>;
  listNotifications(userId: string, unreadOnly: boolean, limit: number): Promise<AppNotification[]>;
  markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void>;

  // rate limiting
  recordRateEvent(key: string): Promise<void>;
  countRateEvents(key: string, sinceIso: string): Promise<number>;
  pruneRateEvents(beforeIso: string): Promise<void>;

  close(): Promise<void>;
}

export function toSummary(a: AnalysisRecord): AnalysisSummary {
  const s = a.result?.setup;
  return {
    id: a.id,
    status: a.status,
    createdAt: a.createdAt,
    symbol: a.symbol,
    timeframes: a.timeframes,
    finalDecision: a.derived?.finalDecision ?? null,
    direction: a.derived?.direction ?? null,
    grade: a.derived?.grade ?? null,
    confidence: s?.confidence ?? null,
    entryLow: s?.entry_low ?? null,
    entryHigh: s?.entry_high ?? null,
    stopLoss: s?.stop_loss ?? null,
    tp1: s?.tp1 ?? null,
    tp2: s?.tp2 ?? null,
    rr: a.derived?.rr?.primary ?? null,
    thumbnailKey: a.images[0]?.key ?? null,
    taken: a.taken,
    outcomePnl: a.outcomePnl,
    costUsd: a.usage?.costUsd ?? null,
  };
}
