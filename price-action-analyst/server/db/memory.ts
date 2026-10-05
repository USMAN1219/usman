/**
 * In-memory repository for tests and zero-setup local development.
 * Data is lost on restart. Refused in production by config validation.
 */
import type { AnalysisRecord, AppNotification, UserSettings } from "../../shared/types.ts";
import { toSummary, type Repository, type UserRow, type WatchlistRow } from "./types.ts";

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const upper = (s: string | null | undefined) => (s ?? "").toUpperCase();

export class MemoryRepository implements Repository {
  private users = new Map<string, UserRow>();
  private settings = new Map<string, UserSettings>();
  private analyses = new Map<string, AnalysisRecord>();
  private watch = new Map<string, WatchlistRow>();
  private notes = new Map<string, AppNotification & { userId: string }>();
  private rate: { key: string; at: string }[] = [];

  async createUser(u: { id: string; email: string; passwordHash: string }) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const row = { ...u, createdAt: now() };
    this.users.set(u.id, row);
    return clone(row);
  }
  async findUserByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    return u ? clone(u) : null;
  }
  async findUserById(id: string) {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }

  async getSettings(userId: string) {
    const s = this.settings.get(userId);
    return s ? clone(s) : null;
  }
  async saveSettings(userId: string, s: UserSettings) {
    this.settings.set(userId, clone(s));
  }

  async createAnalysis(a: Parameters<Repository["createAnalysis"]>[0]) {
    const rec: AnalysisRecord = {
      ...a,
      status: "queued",
      createdAt: now(),
      completedAt: null,
      symbol: a.symbolHint,
      result: null,
      derived: null,
      error: null,
      usage: null,
      taken: false,
      takenAt: null,
      outcomePnl: null,
      outcomeNote: null,
    };
    this.analyses.set(a.id, rec);
    return clone(rec);
  }
  async getAnalysis(userId: string, id: string) {
    const a = this.analyses.get(id);
    return a && a.userId === userId ? clone(a) : null;
  }
  async getAnalysisForJob(id: string) {
    const a = this.analyses.get(id);
    return a ? clone(a) : null;
  }
  async claimAnalysis(id: string) {
    const a = this.analyses.get(id);
    if (!a || a.status !== "queued") return false;
    a.status = "processing";
    return true;
  }
  async setAnalysisStatus(id: string, status: AnalysisRecord["status"], error: string | null = null) {
    const a = this.analyses.get(id);
    if (!a) return;
    a.status = status;
    a.error = error;
    if (status === "failed" || status === "completed") a.completedAt = now();
  }
  async completeAnalysis(id: string, d: Parameters<Repository["completeAnalysis"]>[1]) {
    const a = this.analyses.get(id);
    if (!a) return;
    Object.assign(a, clone(d), { status: "completed", completedAt: now(), error: null });
  }
  async listAnalyses(userId: string, f: Parameters<Repository["listAnalyses"]>[1]) {
    let rows = [...this.analyses.values()].filter((a) => a.userId === userId);
    if (f.symbol) rows = rows.filter((a) => upper(a.symbol) === upper(f.symbol));
    if (f.direction) rows = rows.filter((a) => a.derived?.direction === f.direction);
    if (f.grade) rows = rows.filter((a) => a.derived?.grade === f.grade);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: rows.slice(f.offset, f.offset + f.limit).map((a) => toSummary(clone(a))), total: rows.length };
  }
  async findRecentByHash(userId: string, hash: string, since: string) {
    const a = [...this.analyses.values()]
      .filter((x) => x.userId === userId && x.inputHash === hash && x.status === "completed" && x.createdAt >= since)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return a ? clone(a) : null;
  }
  async latestCompletedForSymbol(userId: string, symbol: string, excludeId?: string) {
    const a = [...this.analyses.values()]
      .filter((x) => x.userId === userId && x.status === "completed" && upper(x.symbol) === upper(symbol) && x.id !== excludeId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return a ? clone(a) : null;
  }
  async deleteAnalysis(userId: string, id: string) {
    const a = this.analyses.get(id);
    if (!a || a.userId !== userId) return null;
    this.analyses.delete(id);
    return clone(a);
  }
  async setOutcome(userId: string, id: string, o: { taken: boolean; outcomePnl: number | null; outcomeNote: string | null }) {
    const a = this.analyses.get(id);
    if (!a || a.userId !== userId) return null;
    a.taken = o.taken;
    a.takenAt = o.taken ? (a.takenAt ?? now()) : null;
    a.outcomePnl = o.outcomePnl;
    a.outcomeNote = o.outcomeNote;
    return clone(a);
  }
  async takenSince(userId: string, since: string) {
    const rows = [...this.analyses.values()].filter((a) => a.userId === userId && a.taken && a.takenAt && a.takenAt >= since);
    return { count: rows.length, pnl: rows.reduce((s, a) => s + (a.outcomePnl ?? 0), 0) };
  }
  async usageSince(userId: string | null, since: string) {
    const rows = [...this.analyses.values()].filter((a) => (userId == null || a.userId === userId) && a.createdAt >= since);
    return {
      analyses: rows.length,
      costUsd: rows.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0),
      inputTokens: rows.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0),
    };
  }
  async countAnalysesSince(userId: string, since: string) {
    return [...this.analyses.values()].filter((a) => a.userId === userId && a.createdAt >= since).length;
  }

  async listWatchlist(userId: string) {
    return [...this.watch.values()].filter((w) => w.userId === userId).sort((a, b) => a.symbol.localeCompare(b.symbol)).map(clone);
  }
  async addWatchlist(row: Omit<WatchlistRow, "createdAt">) {
    if ([...this.watch.values()].some((w) => w.userId === row.userId && upper(w.symbol) === upper(row.symbol)))
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    const full = { ...row, createdAt: now() };
    this.watch.set(row.id, full);
    return clone(full);
  }
  async updateWatchlist(userId: string, id: string, patch: Partial<Pick<WatchlistRow, "notes" | "pointValue" | "statusOverride">>) {
    const w = this.watch.get(id);
    if (!w || w.userId !== userId) return null;
    Object.assign(w, patch);
    return clone(w);
  }
  async deleteWatchlist(userId: string, id: string) {
    const w = this.watch.get(id);
    if (!w || w.userId !== userId) return false;
    return this.watch.delete(id);
  }
  async findWatchlistBySymbol(userId: string, symbol: string) {
    const w = [...this.watch.values()].find((x) => x.userId === userId && upper(x.symbol) === upper(symbol));
    return w ? clone(w) : null;
  }

  async addNotification(n: Parameters<Repository["addNotification"]>[0]) {
    this.notes.set(n.id, { ...n, createdAt: now(), readAt: null });
  }
  async listNotifications(userId: string, unreadOnly: boolean, limit: number) {
    return [...this.notes.values()]
      .filter((n) => n.userId === userId && (!unreadOnly || !n.readAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ userId: _u, ...n }) => clone(n));
  }
  async markNotificationsRead(userId: string, ids: string[] | "all") {
    for (const n of this.notes.values()) {
      if (n.userId === userId && !n.readAt && (ids === "all" || ids.includes(n.id))) n.readAt = now();
    }
  }

  async recordRateEvent(key: string) {
    this.rate.push({ key, at: now() });
  }
  async countRateEvents(key: string, since: string) {
    return this.rate.filter((r) => r.key === key && r.at >= since).length;
  }
  async pruneRateEvents(before: string) {
    this.rate = this.rate.filter((r) => r.at >= before);
  }
  async close() {}
}
