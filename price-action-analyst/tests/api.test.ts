import { describe, expect, it } from "vitest";
import { AnalysisError, type ChartAnalyzer } from "../server/ai/analyzer.ts";
import { chartForm, makePng, registeredClient, testClient, testServices } from "./helpers.ts";

describe("auth", () => {
  it("registers, reads the session, logs out", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const me = await c.request("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe("trader@example.com");
    await c.request("POST", "/auth/logout");
    c.setCookie("");
    expect((await c.request("GET", "/auth/me")).status).toBe(401);
  });

  it("sets an HttpOnly SameSite cookie and never stores the plain password", async () => {
    const s = testServices();
    const c = testClient(s);
    const res = await c.request("POST", "/auth/register", { email: "A@Example.com", password: "correct horse battery" });
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    const user = await s.repo.findUserByEmail("a@example.com");
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toContain("correct horse");
  });

  it("rejects wrong passwords and rate limits brute force", async () => {
    const s = testServices({ LOGIN_ATTEMPTS_PER_15_MIN: "3" });
    await registeredClient(s);
    const c = testClient(s);
    for (let i = 0; i < 3; i++) expect((await c.request("POST", "/auth/login", { email: "trader@example.com", password: "wrong password!!" })).status).toBe(401);
    expect((await c.request("POST", "/auth/login", { email: "trader@example.com", password: "correct horse battery" })).status).toBe(429);
  });

  it("enforces invite codes and closed registration", async () => {
    const s = testServices({ REGISTRATION_INVITE_CODE: "let-me-in" });
    const c = testClient(s);
    expect((await c.request("POST", "/auth/register", { email: "x@example.com", password: "correct horse battery" })).status).toBe(403);
    expect((await c.request("POST", "/auth/register", { email: "x@example.com", password: "correct horse battery", inviteCode: "let-me-in" })).status).toBe(201);
    const closed = testClient(testServices({ REGISTRATION_ENABLED: "false" }));
    expect((await closed.request("POST", "/auth/register", { email: "y@example.com", password: "correct horse battery" })).status).toBe(403);
  });

  it("blocks state-changing requests without the CSRF header or from another origin", async () => {
    const s = testServices();
    const c = testClient(s);
    const noHeader = await c.app.request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "z@example.com", password: "correct horse battery" }),
    });
    expect(noHeader.status).toBe(403);
    const evil = await c.request("POST", "/auth/register", { email: "z@example.com", password: "correct horse battery" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
  });

  it("requires authentication for data routes", async () => {
    const c = testClient(testServices());
    for (const p of ["/analyses", "/settings", "/watchlist", "/notifications", "/usage", "/risk/today"]) {
      expect((await c.request("GET", p)).status).toBe(401);
    }
  });
});

describe("analyses", () => {
  it("runs the full pipeline: upload -> AI -> guardrails -> stored result", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const res = await c.request("POST", "/analyses", chartForm(3, ["4H", "15 min", "M5"], { symbol: "eurusd" }));
    expect(res.status).toBe(202);
    const id = res.json.analysis.id;
    const got = await c.request("GET", `/analyses/${id}`);
    expect(got.json.analysis.status).toBe("completed");
    expect(got.json.analysis.symbol).toBe("EURUSD");
    expect(got.json.analysis.images.map((i: any) => i.label)).toEqual(["4h", "15m", "5m"]);
    expect(got.json.analysis.derived.finalDecision).toBe("potential_long");
    expect(got.json.analysis.derived.rr.primary).toBeGreaterThan(2);

    const list = await c.request("GET", "/analyses?symbol=EURUSD");
    expect(list.json.total).toBe(1);
    expect(list.json.items[0]).toMatchObject({ grade: "A", direction: "long", entryLow: 101.4, stopLoss: 100.4 });

    const img = await c.request("GET", `/analyses/${id}/images/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });

  it("returns the earlier analysis for duplicate uploads unless forced", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const first = await c.request("POST", "/analyses", chartForm(1));
    const second = await c.request("POST", "/analyses", chartForm(1));
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.analysis.id).toBe(first.json.analysis.id);
    const forced = await c.request("POST", "/analyses", chartForm(1, undefined, { force: "true" }));
    expect(forced.status).toBe(202);
    expect(forced.json.analysis.id).not.toBe(first.json.analysis.id);
  });

  it("validates uploads by content, not by filename", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const fake = new FormData();
    fake.append("images", new File([new TextEncoder().encode("<script>alert(1)</script>")], "chart.png", { type: "image/png" }));
    expect((await c.request("POST", "/analyses", fake)).json.error.message).toMatch(/not a PNG, JPEG or WebP/);

    const tiny = new FormData();
    tiny.append("images", new File([makePng(120, 80) as BlobPart], "tiny.png", { type: "image/png" }));
    expect((await c.request("POST", "/analyses", tiny)).json.error.message).toMatch(/resolution is insufficient/);

    expect((await c.request("POST", "/analyses", new FormData())).status).toBe(400);
    expect((await c.request("POST", "/analyses", chartForm(7, Array(7).fill(null)))).json.error.message).toMatch(/at most 6/);
  });

  it("enforces per-user hourly limits and the monthly budget", async () => {
    const s = testServices({ RATE_LIMIT_ANALYSES_PER_HOUR: "2" });
    const c = await registeredClient(s);
    for (let i = 0; i < 2; i++) expect((await c.request("POST", "/analyses", chartForm(1, undefined, { notes: `run ${i}` }))).status).toBe(202);
    const third = await c.request("POST", "/analyses", chartForm(1, undefined, { notes: "run 3" }));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();

    const costly: ChartAnalyzer = {
      analyze: async (input) => {
        const out = await new (await import("../server/ai/mock.ts")).MockChartAnalyzer().analyze(input);
        return { ...out, usage: { ...out.usage, costUsd: 5 } };
      },
    };
    const b = testServices({ MONTHLY_BUDGET_USD: "4" }, costly);
    const bc = await registeredClient(b);
    expect((await bc.request("POST", "/analyses", chartForm(1))).status).toBe(202);
    expect((await bc.request("POST", "/analyses", chartForm(1, undefined, { force: "true" }))).status).toBe(503);
  });

  it("isolates users from each other's analyses and images", async () => {
    const s = testServices();
    const alice = await registeredClient(s, "alice@example.com");
    const bob = await registeredClient(s, "bob@example.com");
    const id = (await alice.request("POST", "/analyses", chartForm(1))).json.analysis.id;
    expect((await bob.request("GET", `/analyses/${id}`)).status).toBe(404);
    expect((await bob.request("GET", `/analyses/${id}/images/0`)).status).toBe(404);
    expect((await bob.request("DELETE", `/analyses/${id}`)).status).toBe(404);
    expect((await bob.request("GET", "/analyses")).json.total).toBe(0);
  });

  it("reports model failures to the user and allows retry", async () => {
    let fail = true;
    const flaky: ChartAnalyzer = {
      analyze: async (input) => {
        if (fail) throw new AnalysisError("Price scale is not readable.", true);
        return new (await import("../server/ai/mock.ts")).MockChartAnalyzer().analyze(input);
      },
    };
    const s = testServices({}, flaky);
    const c = await registeredClient(s);
    const id = (await c.request("POST", "/analyses", chartForm(1))).json.analysis.id;
    const failed = (await c.request("GET", `/analyses/${id}`)).json.analysis;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Price scale is not readable.");
    fail = false;
    const retried = await c.request("POST", `/analyses/${id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.json.analysis.status).toBe("completed");
    expect((await c.request("GET", `/analyses/${id}`)).status).toBe(404);
  });

  it("deletes analyses and their stored screenshots", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const a = (await c.request("POST", "/analyses", chartForm(2))).json.analysis;
    expect(await s.storage.get(a.images[0].key)).not.toBeNull();
    expect((await c.request("DELETE", `/analyses/${a.id}`)).status).toBe(200);
    expect(await s.storage.get(a.images[0].key)).toBeNull();
  });
});

describe("settings, watchlist, alerts, daily risk", () => {
  it("validates risk settings (no excessive risk)", async () => {
    const c = await registeredClient(testServices());
    const { settings } = (await c.request("GET", "/settings")).json;
    expect(settings.riskPercent).toBe(1);
    expect((await c.request("PUT", "/settings", { ...settings, riskPercent: 25 })).status).toBe(400);
    const ok = await c.request("PUT", "/settings", { ...settings, accountBalance: 25000, riskPercent: 0.5 });
    expect(ok.status).toBe(200);
    expect((await c.request("GET", "/settings")).json.settings.accountBalance).toBe(25000);
  });

  it("derives watchlist status from the latest analysis and uses point value for sizing", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const { settings } = (await c.request("GET", "/settings")).json;
    await c.request("PUT", "/settings", { ...settings, accountBalance: 10000, riskPercent: 1 });
    expect((await c.request("POST", "/watchlist", { symbol: "xauusd", pointValue: 100 })).status).toBe(201);
    expect((await c.request("POST", "/watchlist", { symbol: "XAUUSD" })).status).toBe(409);
    expect((await c.request("POST", "/watchlist", { symbol: "OANDA:XAU/USD" })).status).toBe(409);
    let wl = (await c.request("GET", "/watchlist")).json.items;
    expect(wl[0].effectiveStatus).toBe("no_setup");

    const a = (await c.request("POST", "/analyses", chartForm(1, ["1h"], { symbol: "XAUUSD" }))).json.analysis;
    const full = (await c.request("GET", `/analyses/${a.id}`)).json.analysis;
    expect(full.derived.sizing.available).toBe(true);
    expect(full.derived.sizing.riskAmount).toBe(100);

    wl = (await c.request("GET", "/watchlist")).json.items;
    expect(wl[0].effectiveStatus).toBe("strong_setup");
    await c.request("PATCH", `/watchlist/${wl[0].id}`, { statusOverride: "watch" });
    expect((await c.request("GET", "/watchlist")).json.items[0].effectiveStatus).toBe("watch");
  });

  it("creates optional alerts only when enabled", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    await c.request("POST", "/analyses", chartForm(1, ["15m"], { symbol: "BTCUSD" }));
    expect((await c.request("GET", "/notifications")).json.items).toHaveLength(0);

    const { settings } = (await c.request("GET", "/settings")).json;
    await c.request("PUT", "/settings", { ...settings, alerts: { ...settings.alerts, enabled: true } });
    await c.request("POST", "/analyses", chartForm(1, ["15m"], { symbol: "BTCUSD", force: "true" }));
    const kinds = (await c.request("GET", "/notifications?unread=1")).json.items.map((n: any) => n.kind).sort();
    expect(kinds).toEqual(["a_setup", "liquidity_sweep"]);
    await c.request("POST", "/notifications/read", { ids: "all" });
    expect((await c.request("GET", "/notifications?unread=1")).json.items).toHaveLength(0);
  });

  it("tracks trades taken today against the daily limits", async () => {
    const s = testServices();
    const c = await registeredClient(s);
    const { settings } = (await c.request("GET", "/settings")).json;
    await c.request("PUT", "/settings", { ...settings, accountBalance: 10000, maxDailyLossPercent: 2, maxTradesPerDay: 2 });
    const id = (await c.request("POST", "/analyses", chartForm(1))).json.analysis.id;
    await c.request("PATCH", `/analyses/${id}/outcome`, { taken: true, outcomePnl: -250 });
    const since = new Date(Date.now() - 3600_000).toISOString();
    const risk = (await c.request("GET", `/risk/today?since=${encodeURIComponent(since)}`)).json.status;
    expect(risk).toMatchObject({ tradesTaken: 1, realisedPnl: -250, maxDailyLoss: 200, lossLimitReached: true, tradeLimitReached: false });
  });
});

