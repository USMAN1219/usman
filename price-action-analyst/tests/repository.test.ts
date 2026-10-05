/**
 * Contract tests run against every Repository implementation.
 * PostgreSQL runs only when TEST_DATABASE_URL is set (it is wiped and re-migrated).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRepository } from "../server/db/memory.ts";
import { createSql, PostgresRepository } from "../server/db/postgres.ts";
import { migrate } from "../server/db/schema.ts";
import type { Repository } from "../server/db/types.ts";
import { applyGuardrails } from "../server/analysis/guardrails.ts";
import { mockAnalysis } from "../server/ai/mock.ts";
import { DEFAULT_SETTINGS } from "../shared/types.ts";

const pgUrl = process.env.TEST_DATABASE_URL;

const impls: [string, () => Promise<Repository>][] = [["memory", async () => new MemoryRepository()]];
if (pgUrl) {
  impls.push([
    "postgres",
    async () => {
      const sql = createSql(pgUrl);
      await sql.unsafe("DROP TABLE IF EXISTS rate_events, notifications, watchlist, analyses, user_settings, users CASCADE");
      await Promise.all([migrate(sql), migrate(sql)]); // concurrent cold starts must not race
      await migrate(sql); // idempotent
      return new PostgresRepository(sql);
    },
  ]);
}

describe.each(impls)("Repository contract: %s", (_name, make) => {
  let repo: Repository;
  beforeAll(async () => {
    repo = await make();
  });
  afterAll(async () => repo.close());

  const newAnalysis = (userId: string, hash = "h1") => ({
    id: randomUUID(),
    userId,
    symbolHint: "EURUSD",
    timeframes: ["4h", "15m"],
    images: [{ key: `${userId}/x/0.png`, label: "4h", mime: "image/png", bytes: 10, width: 800, height: 500, sha256: "abc" }],
    notes: null,
    inputHash: hash,
  });

  it("stores users, settings and enforces unique emails", async () => {
    const u = await repo.createUser({ id: randomUUID(), email: "c@example.com", passwordHash: "x" });
    expect((await repo.findUserByEmail("c@example.com"))?.id).toBe(u.id);
    await expect(repo.createUser({ id: randomUUID(), email: "c@example.com", passwordHash: "y" })).rejects.toMatchObject({ code: "23505" });
    expect(await repo.getSettings(u.id)).toBeNull();
    await repo.saveSettings(u.id, { ...DEFAULT_SETTINGS, minRr: 3 });
    await repo.saveSettings(u.id, { ...DEFAULT_SETTINGS, minRr: 2.5 });
    expect((await repo.getSettings(u.id))?.minRr).toBe(2.5);
  });

  it("runs the analysis lifecycle with single-claim semantics", async () => {
    const u = await repo.createUser({ id: randomUUID(), email: "d@example.com", passwordHash: "x" });
    const a = await repo.createAnalysis(newAnalysis(u.id));
    expect(a.status).toBe("queued");
    expect(await repo.claimAnalysis(a.id)).toBe(true);
    expect(await repo.claimAnalysis(a.id)).toBe(false);

    const result = mockAnalysis({ images: [{ data: new Uint8Array(), mime: "image/png", label: "4h", width: 800, height: 500 }], symbolHint: "EURUSD", notes: null });
    const derived = applyGuardrails({ analysis: result, settings: DEFAULT_SETTINGS, pointValue: null });
    await repo.completeAnalysis(a.id, {
      result,
      derived,
      symbol: "EURUSD",
      timeframes: ["4h", "15m"],
      usage: { model: "m", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, durationMs: 1234 },
    });
    const got = (await repo.getAnalysis(u.id, a.id))!;
    expect(got.status).toBe("completed");
    expect(got.result?.setup.stop_loss).toBe(100.4);
    expect(got.derived?.finalDecision).toBe("potential_long");
    expect(got.usage?.costUsd).toBe(0.25);
    expect(await repo.getAnalysis(randomUUID(), a.id)).toBeNull();

    const list = await repo.listAnalyses(u.id, { limit: 10, offset: 0, direction: "long", symbol: "eurusd" });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ grade: "A", rr: derived.rr?.primary, entryLow: 101.4 });
    expect((await repo.listAnalyses(u.id, { limit: 10, offset: 0, direction: "short" })).total).toBe(0);

    expect((await repo.findRecentByHash(u.id, "h1", new Date(Date.now() - 3600_000).toISOString()))?.id).toBe(a.id);
    expect((await repo.latestCompletedForSymbol(u.id, "eurusd"))?.id).toBe(a.id);
    expect(await repo.latestCompletedForSymbol(u.id, "eurusd", a.id)).toBeNull();

    const usage = await repo.usageSince(u.id, new Date(Date.now() - 3600_000).toISOString());
    expect(usage).toMatchObject({ analyses: 1, costUsd: 0.25, inputTokens: 1000, outputTokens: 500 });

    await repo.setOutcome(u.id, a.id, { taken: true, outcomePnl: -40, outcomeNote: "stopped" });
    expect(await repo.takenSince(u.id, new Date(Date.now() - 3600_000).toISOString())).toEqual({ count: 1, pnl: -40 });

    await repo.setAnalysisStatus(a.id, "failed", "boom");
    expect((await repo.getAnalysis(u.id, a.id))?.error).toBe("boom");
    expect((await repo.deleteAnalysis(u.id, a.id))?.id).toBe(a.id);
    expect(await repo.getAnalysis(u.id, a.id)).toBeNull();
  });

  it("manages watchlist, notifications and rate events", async () => {
    const u = await repo.createUser({ id: randomUUID(), email: "e@example.com", passwordHash: "x" });
    const w = await repo.addWatchlist({ id: randomUUID(), userId: u.id, symbol: "GBPUSD", notes: null, pointValue: 10, statusOverride: null });
    await expect(repo.addWatchlist({ id: randomUUID(), userId: u.id, symbol: "gbpusd", notes: null, pointValue: null, statusOverride: null })).rejects.toMatchObject({ code: "23505" });
    expect((await repo.updateWatchlist(u.id, w.id, { statusOverride: "watch" }))?.statusOverride).toBe("watch");
    expect((await repo.findWatchlistBySymbol(u.id, "gbpUSD"))?.pointValue).toBe(10);
    expect(await repo.updateWatchlist(randomUUID(), w.id, { notes: "x" })).toBeNull();
    expect(await repo.deleteWatchlist(u.id, w.id)).toBe(true);

    const n = randomUUID();
    await repo.addNotification({ id: n, userId: u.id, analysisId: null, kind: "a_setup", title: "t", body: "b" });
    expect(await repo.listNotifications(u.id, true, 10)).toHaveLength(1);
    await repo.markNotificationsRead(u.id, [n]);
    expect(await repo.listNotifications(u.id, true, 10)).toHaveLength(0);
    expect(await repo.listNotifications(u.id, false, 10)).toHaveLength(1);

    const since = new Date(Date.now() - 60_000).toISOString();
    await repo.recordRateEvent("k");
    await repo.recordRateEvent("k");
    expect(await repo.countRateEvents("k", since)).toBe(2);
    await repo.pruneRateEvents(new Date(Date.now() + 60_000).toISOString());
    expect(await repo.countRateEvents("k", since)).toBe(0);
  });
});

describe.runIf(pgUrl)("auto-migration on an empty database", () => {
  it("creates the schema on the first API request", async () => {
    const { buildServices } = await import("../server/services.ts");
    const { loadConfig } = await import("../server/config.ts");
    const { testClient } = await import("./helpers.ts");
    const freshUrl = pgUrl!.replace(/\/[^/]+$/, "/paa_fresh");
    const wipe = createSql(freshUrl);
    await wipe.unsafe("DROP TABLE IF EXISTS rate_events, notifications, watchlist, analyses, user_settings, users CASCADE");
    await wipe.end();
    const services = buildServices(
      loadConfig({ APP_ENV: "test", DB_DRIVER: "postgres", DATABASE_URL: freshUrl, STORAGE_DRIVER: "memory", AI_PROVIDER: "mock" }),
    );
    const c = testClient(services);
    const res = await c.request("POST", "/auth/register", { email: "fresh@example.com", password: "correct horse battery" });
    expect(res.status).toBe(201);
    expect((await c.request("GET", "/watchlist")).status).toBe(200);
    await services.repo.close();
  });
});
