/** Settings, watchlist, notifications, daily risk status and usage. */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../errors.ts";
import { getUserSettings } from "../../services.ts";
import { normalizeSymbol, type DailyRiskStatus, type UsageSummary, type UserSettings, type WatchlistItem, type WatchStatus } from "../../../shared/types.ts";
import { requireUser, type Env } from "../middleware.ts";

export const accountRoutes = new Hono<Env>();
// Mounted at the API root, so guard only this router's own paths.
for (const path of ["/settings", "/watchlist", "/watchlist/*", "/notifications", "/notifications/*", "/risk/*", "/usage"]) {
  accountRoutes.use(path, requireUser);
}

const WATCH_STATUSES = ["strong_setup", "developing_setup", "watch", "no_setup"] as const;

const SettingsSchema = z.object({
  accountBalance: z.number().positive().max(1e12).nullable(),
  accountCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3,5}$/, "Use a currency code such as USD."),
  riskPercent: z.number().min(0.01).max(5, "Risk per trade above 5% is not supported. 0.5%-1% is recommended."),
  maxDailyLossPercent: z.number().min(0.1).max(20),
  maxTradesPerDay: z.number().int().min(1).max(50),
  minRr: z.number().min(0.5).max(20),
  minGrade: z.enum(["A+", "A", "B", "C"]),
  alerts: z.object({
    enabled: z.boolean(),
    aSetup: z.boolean(),
    approachingLevel: z.boolean(),
    approachingThresholdPercent: z.number().min(0.01).max(5),
    liquiditySweep: z.boolean(),
    breakoutRetest: z.boolean(),
    setupInvalidated: z.boolean(),
    browserNotifications: z.boolean(),
  }),
});

accountRoutes.get("/settings", async (c) => c.json({ settings: await getUserSettings(c.get("services").repo, c.get("user").id) }));

accountRoutes.put("/settings", async (c) => {
  const settings: UserSettings = SettingsSchema.parse(await c.req.json());
  await c.get("services").repo.saveSettings(c.get("user").id, settings);
  return c.json({ settings });
});

// ---- watchlist -------------------------------------------------------------

const SymbolSchema = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const n = normalizeSymbol(s);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter a symbol such as EURUSD or XAUUSD." });
    return n ?? "";
  });

accountRoutes.get("/watchlist", async (c) => {
  const { repo } = c.get("services");
  const userId = c.get("user").id;
  const rows = await repo.listWatchlist(userId);
  const items: WatchlistItem[] = await Promise.all(
    rows.map(async (r) => {
      const latest = await repo.latestCompletedForSymbol(userId, r.symbol);
      const derivedStatus: WatchStatus = latest?.derived?.watchStatus ?? "no_setup";
      return {
        id: r.id,
        symbol: r.symbol,
        notes: r.notes,
        pointValue: r.pointValue,
        statusOverride: r.statusOverride,
        createdAt: r.createdAt,
        latest: latest
          ? {
              analysisId: latest.id,
              createdAt: latest.createdAt,
              status: derivedStatus,
              finalDecision: latest.derived?.finalDecision ?? null,
              grade: latest.derived?.grade ?? null,
            }
          : null,
        effectiveStatus: r.statusOverride ?? derivedStatus,
      };
    }),
  );
  const order: Record<WatchStatus, number> = { strong_setup: 0, developing_setup: 1, watch: 2, no_setup: 3 };
  items.sort((a, b) => order[a.effectiveStatus] - order[b.effectiveStatus] || a.symbol.localeCompare(b.symbol));
  return c.json({ items });
});

accountRoutes.post("/watchlist", async (c) => {
  const body = z
    .object({
      symbol: SymbolSchema,
      notes: z.string().trim().max(500).nullable().default(null),
      pointValue: z.number().positive().max(1e9).nullable().default(null),
    })
    .parse(await c.req.json());
  const { repo } = c.get("services");
  const userId = c.get("user").id;
  if ((await repo.listWatchlist(userId)).length >= 200) throw badRequest("Watchlist is limited to 200 symbols.");
  const row = await repo
    .addWatchlist({ id: randomUUID(), userId, symbol: body.symbol, notes: body.notes, pointValue: body.pointValue, statusOverride: null })
    .catch((e) => {
      if (e?.code === "23505") throw conflict(`${body.symbol} is already on your watchlist.`);
      throw e;
    });
  return c.json({ item: row }, 201);
});

accountRoutes.patch("/watchlist/:id", async (c) => {
  const patch = z
    .object({
      notes: z.string().trim().max(500).nullable().optional(),
      pointValue: z.number().positive().max(1e9).nullable().optional(),
      statusOverride: z.enum(WATCH_STATUSES).nullable().optional(),
    })
    .parse(await c.req.json());
  const row = await c.get("services").repo.updateWatchlist(c.get("user").id, c.req.param("id"), patch);
  if (!row) throw notFound("Watchlist item not found.");
  return c.json({ item: row });
});

accountRoutes.delete("/watchlist/:id", async (c) => {
  const ok = await c.get("services").repo.deleteWatchlist(c.get("user").id, c.req.param("id"));
  if (!ok) throw notFound("Watchlist item not found.");
  return c.json({ ok: true });
});

// ---- notifications -----------------------------------------------------------

accountRoutes.get("/notifications", async (c) => {
  const unread = c.req.query("unread") === "1";
  const items = await c.get("services").repo.listNotifications(c.get("user").id, unread, 50);
  return c.json({ items });
});

accountRoutes.post("/notifications/read", async (c) => {
  const body = z.object({ ids: z.union([z.literal("all"), z.array(z.string().uuid()).max(100)]) }).parse(await c.req.json());
  await c.get("services").repo.markNotificationsRead(c.get("user").id, body.ids);
  return c.json({ ok: true });
});

// ---- daily risk ----------------------------------------------------------------

accountRoutes.get("/risk/today", async (c) => {
  const { repo } = c.get("services");
  const userId = c.get("user").id;
  // The browser sends its local midnight so "today" matches the trader's day.
  const since = z.string().datetime({ offset: true }).safeParse(c.req.query("since"));
  const sinceDate = since.success ? new Date(since.data) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  if (Math.abs(Date.now() - sinceDate.getTime()) > 48 * 3600_000) throw badRequest("'since' must be within the last 48 hours.");
  const settings = await getUserSettings(repo, userId);
  const { count, pnl } = await repo.takenSince(userId, sinceDate.toISOString());
  const maxLoss = settings.accountBalance ? (settings.accountBalance * settings.maxDailyLossPercent) / 100 : null;
  const status: DailyRiskStatus = {
    date: sinceDate.toISOString(),
    tradesTaken: count,
    maxTrades: settings.maxTradesPerDay,
    realisedPnl: Math.round(pnl * 100) / 100,
    maxDailyLoss: maxLoss != null ? Math.round(maxLoss * 100) / 100 : null,
    tradeLimitReached: count >= settings.maxTradesPerDay,
    lossLimitReached: maxLoss != null && pnl <= -maxLoss,
  };
  return c.json({ status });
});

// ---- usage -----------------------------------------------------------------------

accountRoutes.get("/usage", async (c) => {
  const { repo, config } = c.get("services");
  const userId = c.get("user").id;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const month = await repo.usageSince(userId, monthStart);
  const today = await repo.countAnalysesSince(userId, new Date(Date.now() - 86400_000).toISOString());
  const summary: UsageSummary = {
    monthStart,
    analysesThisMonth: month.analyses,
    costThisMonthUsd: Math.round(month.costUsd * 10000) / 10000,
    inputTokens: month.inputTokens,
    outputTokens: month.outputTokens,
    analysesToday: today,
    limits: {
      perHour: config.RATE_LIMIT_ANALYSES_PER_HOUR,
      perDay: config.RATE_LIMIT_ANALYSES_PER_DAY,
      monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
    },
  };
  return c.json({ usage: summary });
});
