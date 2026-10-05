/**
 * PostgreSQL repository (works with Neon / Netlify DB, Supabase, RDS, etc.).
 * All statements are parameterised through the `postgres` tagged template.
 * Use a pooled connection string in serverless environments.
 */
import postgres from "postgres";
import type { AnalysisRecord, AppNotification, UserSettings } from "../../shared/types.ts";
import { toSummary, type Repository, type UserRow, type WatchlistRow } from "./types.ts";

type Sql = postgres.Sql;
type Row = Record<string, any>;

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function mapAnalysis(r: Row): AnalysisRecord {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
    symbol: r.symbol,
    symbolHint: r.symbol_hint,
    timeframes: r.timeframes ?? [],
    images: r.images,
    notes: r.notes,
    inputHash: r.input_hash,
    result: r.result,
    derived: r.derived,
    error: r.error,
    usage: r.model
      ? {
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
          costUsd: r.cost_usd,
          durationMs: r.duration_ms,
        }
      : null,
    taken: r.taken,
    takenAt: iso(r.taken_at),
    outcomePnl: r.outcome_pnl,
    outcomeNote: r.outcome_note,
  };
}

const mapUser = (r: Row): UserRow => ({ id: r.id, email: r.email, passwordHash: r.password_hash, createdAt: iso(r.created_at)! });
const mapWatch = (r: Row): WatchlistRow => ({
  id: r.id,
  userId: r.user_id,
  symbol: r.symbol,
  notes: r.notes,
  pointValue: r.point_value,
  statusOverride: r.status_override,
  createdAt: iso(r.created_at)!,
});

export function createSql(url: string): Sql {
  return postgres(url, {
    max: 3, // serverless: keep per-instance connections low; rely on the provider's pooler
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // compatible with transaction-mode poolers (PgBouncer, Neon pooler)
    onnotice: () => {},
  });
}

export class PostgresRepository implements Repository {
  constructor(private readonly sql: Sql) {}

  async createUser(u: { id: string; email: string; passwordHash: string }) {
    const [r] = await this.sql`INSERT INTO users (id, email, password_hash) VALUES (${u.id}, ${u.email}, ${u.passwordHash}) RETURNING *`;
    return mapUser(r!);
  }
  async findUserByEmail(email: string) {
    const [r] = await this.sql`SELECT * FROM users WHERE email = ${email}`;
    return r ? mapUser(r) : null;
  }
  async findUserById(id: string) {
    const [r] = await this.sql`SELECT * FROM users WHERE id = ${id}`;
    return r ? mapUser(r) : null;
  }

  async getSettings(userId: string) {
    const [r] = await this.sql`SELECT settings FROM user_settings WHERE user_id = ${userId}`;
    return r ? (r.settings as UserSettings) : null;
  }
  async saveSettings(userId: string, s: UserSettings) {
    await this.sql`
      INSERT INTO user_settings (user_id, settings, updated_at) VALUES (${userId}, ${this.sql.json(s as any)}, now())
      ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`;
  }

  async createAnalysis(a: Parameters<Repository["createAnalysis"]>[0]) {
    const [r] = await this.sql`
      INSERT INTO analyses (id, user_id, status, symbol, symbol_hint, timeframes, images, notes, input_hash)
      VALUES (${a.id}, ${a.userId}, 'queued', ${a.symbolHint}, ${a.symbolHint}, ${a.timeframes},
              ${this.sql.json(a.images as any)}, ${a.notes}, ${a.inputHash})
      RETURNING *`;
    return mapAnalysis(r!);
  }
  async getAnalysis(userId: string, id: string) {
    const [r] = await this.sql`SELECT * FROM analyses WHERE id = ${id} AND user_id = ${userId}`;
    return r ? mapAnalysis(r) : null;
  }
  async getAnalysisForJob(id: string) {
    const [r] = await this.sql`SELECT * FROM analyses WHERE id = ${id}`;
    return r ? mapAnalysis(r) : null;
  }
  async claimAnalysis(id: string) {
    const rows = await this.sql`UPDATE analyses SET status = 'processing' WHERE id = ${id} AND status = 'queued' RETURNING id`;
    return rows.length === 1;
  }
  async setAnalysisStatus(id: string, status: AnalysisRecord["status"], error: string | null = null) {
    const done = status === "completed" || status === "failed";
    await this.sql`
      UPDATE analyses SET status = ${status}, error = ${error},
        completed_at = CASE WHEN ${done} THEN now() ELSE completed_at END
      WHERE id = ${id}`;
  }
  async completeAnalysis(id: string, d: Parameters<Repository["completeAnalysis"]>[1]) {
    const s = d.result?.setup;
    const u = d.usage;
    await this.sql`
      UPDATE analyses SET
        status = 'completed', completed_at = now(), error = NULL,
        symbol = ${d.symbol}, timeframes = ${d.timeframes},
        result = ${d.result ? this.sql.json(d.result as any) : null},
        derived = ${d.derived ? this.sql.json(d.derived as any) : null},
        final_decision = ${d.derived?.finalDecision ?? null}, direction = ${d.derived?.direction ?? null},
        grade = ${d.derived?.grade ?? null}, confidence = ${s?.confidence ?? null},
        entry_low = ${s?.entry_low ?? null}, entry_high = ${s?.entry_high ?? null}, stop_loss = ${s?.stop_loss ?? null},
        tp1 = ${s?.tp1 ?? null}, tp2 = ${s?.tp2 ?? null}, rr = ${d.derived?.rr?.primary ?? null},
        model = ${u?.model ?? null}, input_tokens = ${u?.inputTokens ?? 0}, output_tokens = ${u?.outputTokens ?? 0},
        cache_read_tokens = ${u?.cacheReadTokens ?? 0}, cache_write_tokens = ${u?.cacheWriteTokens ?? 0},
        cost_usd = ${u?.costUsd ?? 0}, duration_ms = ${u?.durationMs ?? null}
      WHERE id = ${id}`;
  }
  async listAnalyses(userId: string, f: Parameters<Repository["listAnalyses"]>[1]) {
    const sql = this.sql;
    const where = sql`
      user_id = ${userId}
      ${f.symbol ? sql`AND upper(symbol) = upper(${f.symbol})` : sql``}
      ${f.direction ? sql`AND direction = ${f.direction}` : sql``}
      ${f.grade ? sql`AND grade = ${f.grade}` : sql``}`;
    const rows = await sql`SELECT * FROM analyses WHERE ${where} ORDER BY created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`;
    const [c] = await sql`SELECT count(*)::int AS n FROM analyses WHERE ${where}`;
    return { items: rows.map((r) => toSummary(mapAnalysis(r))), total: c!.n as number };
  }
  async findRecentByHash(userId: string, hash: string, since: string) {
    const [r] = await this.sql`
      SELECT * FROM analyses WHERE user_id = ${userId} AND input_hash = ${hash} AND status = 'completed' AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT 1`;
    return r ? mapAnalysis(r) : null;
  }
  async latestCompletedForSymbol(userId: string, symbol: string, excludeId?: string) {
    const [r] = await this.sql`
      SELECT * FROM analyses WHERE user_id = ${userId} AND status = 'completed' AND upper(symbol) = upper(${symbol})
      ${excludeId ? this.sql`AND id <> ${excludeId}` : this.sql``}
      ORDER BY created_at DESC LIMIT 1`;
    return r ? mapAnalysis(r) : null;
  }
  async deleteAnalysis(userId: string, id: string) {
    const [r] = await this.sql`DELETE FROM analyses WHERE id = ${id} AND user_id = ${userId} RETURNING *`;
    return r ? mapAnalysis(r) : null;
  }
  async setOutcome(userId: string, id: string, o: { taken: boolean; outcomePnl: number | null; outcomeNote: string | null }) {
    const [r] = await this.sql`
      UPDATE analyses SET taken = ${o.taken},
        taken_at = CASE WHEN ${o.taken} THEN coalesce(taken_at, now()) ELSE NULL END,
        outcome_pnl = ${o.outcomePnl}, outcome_note = ${o.outcomeNote}
      WHERE id = ${id} AND user_id = ${userId} RETURNING *`;
    return r ? mapAnalysis(r) : null;
  }
  async takenSince(userId: string, since: string) {
    const [r] = await this.sql`
      SELECT count(*)::int AS n, coalesce(sum(outcome_pnl), 0)::float8 AS pnl
      FROM analyses WHERE user_id = ${userId} AND taken AND taken_at >= ${since}`;
    return { count: r!.n as number, pnl: r!.pnl as number };
  }
  async usageSince(userId: string | null, since: string) {
    const [r] = await this.sql`
      SELECT count(*)::int AS n, coalesce(sum(cost_usd), 0)::float8 AS cost,
             coalesce(sum(input_tokens), 0)::int AS inp, coalesce(sum(output_tokens), 0)::int AS outp
      FROM analyses WHERE created_at >= ${since} ${userId ? this.sql`AND user_id = ${userId}` : this.sql``}`;
    return { analyses: r!.n, costUsd: r!.cost, inputTokens: r!.inp, outputTokens: r!.outp };
  }
  async countAnalysesSince(userId: string, since: string) {
    const [r] = await this.sql`SELECT count(*)::int AS n FROM analyses WHERE user_id = ${userId} AND created_at >= ${since}`;
    return r!.n as number;
  }

  async listWatchlist(userId: string) {
    const rows = await this.sql`SELECT * FROM watchlist WHERE user_id = ${userId} ORDER BY symbol`;
    return rows.map(mapWatch);
  }
  async addWatchlist(w: Omit<WatchlistRow, "createdAt">) {
    const [r] = await this.sql`
      INSERT INTO watchlist (id, user_id, symbol, notes, point_value, status_override)
      VALUES (${w.id}, ${w.userId}, ${w.symbol}, ${w.notes}, ${w.pointValue}, ${w.statusOverride}) RETURNING *`;
    return mapWatch(r!);
  }
  async updateWatchlist(userId: string, id: string, p: Partial<Pick<WatchlistRow, "notes" | "pointValue" | "statusOverride">>) {
    const current = (await this.sql`SELECT * FROM watchlist WHERE id = ${id} AND user_id = ${userId}`)[0];
    if (!current) return null;
    const m = { ...mapWatch(current), ...p };
    const [r] = await this.sql`
      UPDATE watchlist SET notes = ${m.notes}, point_value = ${m.pointValue}, status_override = ${m.statusOverride}
      WHERE id = ${id} AND user_id = ${userId} RETURNING *`;
    return r ? mapWatch(r) : null;
  }
  async deleteWatchlist(userId: string, id: string) {
    const rows = await this.sql`DELETE FROM watchlist WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
  }
  async findWatchlistBySymbol(userId: string, symbol: string) {
    const [r] = await this.sql`SELECT * FROM watchlist WHERE user_id = ${userId} AND upper(symbol) = upper(${symbol})`;
    return r ? mapWatch(r) : null;
  }

  async addNotification(n: Parameters<Repository["addNotification"]>[0]) {
    await this.sql`
      INSERT INTO notifications (id, user_id, analysis_id, kind, title, body)
      VALUES (${n.id}, ${n.userId}, ${n.analysisId}, ${n.kind}, ${n.title}, ${n.body})`;
  }
  async listNotifications(userId: string, unreadOnly: boolean, limit: number): Promise<AppNotification[]> {
    const rows = await this.sql`
      SELECT * FROM notifications WHERE user_id = ${userId} ${unreadOnly ? this.sql`AND read_at IS NULL` : this.sql``}
      ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      analysisId: r.analysis_id,
      createdAt: iso(r.created_at)!,
      readAt: iso(r.read_at),
    }));
  }
  async markNotificationsRead(userId: string, ids: string[] | "all") {
    if (ids === "all") await this.sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND read_at IS NULL`;
    else if (ids.length)
      await this.sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND id = ANY(${ids}::uuid[]) AND read_at IS NULL`;
  }

  async recordRateEvent(key: string) {
    await this.sql`INSERT INTO rate_events (key) VALUES (${key})`;
  }
  async countRateEvents(key: string, since: string) {
    const [r] = await this.sql`SELECT count(*)::int AS n FROM rate_events WHERE key = ${key} AND created_at >= ${since}`;
    return r!.n as number;
  }
  async pruneRateEvents(before: string) {
    await this.sql`DELETE FROM rate_events WHERE created_at < ${before}`;
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
}
