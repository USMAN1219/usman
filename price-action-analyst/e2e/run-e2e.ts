/**
 * End-to-end browser test of the built app (npm run build && npm run test:e2e).
 *
 * Serves dist/ plus the API in one Node process using the MOCK analyzer (no
 * API key, no cost), drives Chromium through register -> upload 3 timeframes ->
 * analysis -> history -> watchlist -> settings, checks annotation placement on
 * the synthetic charts, and saves screenshots to e2e/output/screens.
 *
 * With E2E_REAL_AI=1 and ANTHROPIC_API_KEY set it uses the real model instead
 * (costs money; placement checks are then skipped).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { chromium } from "playwright-core";
import { generateCharts, CHART_H } from "./generate-charts.ts";

const realAi = process.env.E2E_REAL_AI === "1";
Object.assign(process.env, {
  APP_ENV: "development",
  DB_DRIVER: "memory",
  STORAGE_DRIVER: "memory",
  ANALYSIS_EXECUTION: "async",
  AI_PROVIDER: realAi ? "anthropic" : "mock",
  APP_URL: "http://127.0.0.1:4599",
});
const { createApp } = await import("../server/http/app.ts");

const out = path.resolve("e2e/output");
const screens = path.join(out, "screens");
await mkdir(screens, { recursive: true });

const root = new Hono();
const api = createApp();
root.all("/api/*", (c) => api.fetch(c.req.raw));
root.use("/*", serveStatic({ root: "./dist" }));
root.get("*", serveStatic({ path: "./dist/index.html" }));
const server = serve({ fetch: root.fetch, port: 4599, hostname: "127.0.0.1" });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const errors: string[] = [];
let failed = false;
let page = undefined as unknown as import("playwright-core").Page; // assigned in try; read in catch
try {
  const charts = await generateCharts(path.join(out, "charts"), "TESTUSD", browser);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

  const step = (name: string) => console.log(`• ${name}`);
  const nav = (name: string) => page.locator("nav.nav").getByRole("link", { name, exact: true });

  step("register");
  await page.goto("http://127.0.0.1:4599/");
  await page.getByText("No account? Create one").click();
  await page.getByLabel("Email").fill("e2e@example.com");
  await page.getByLabel("Password").fill("a-strong-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("New analysis").waitFor();
  if (!realAi) await page.getByText("MOCK AI MODE").waitFor();

  step("add watchlist symbol with point value");
  await nav("Watchlist").click();
  await page.getByPlaceholder("EURUSD, XAUUSD, NAS100…").fill("TESTUSD");
  await page.getByPlaceholder("for position sizing").fill("10");
  await page.getByRole("button", { name: "Add" }).click();
  await page.locator("td strong", { hasText: "TESTUSD" }).waitFor();

  step("set account balance");
  await nav("Settings").click();
  await page.getByLabel("Account balance").fill("10000");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved.").waitFor();

  step("upload three timeframes");
  await nav("Dashboard").click();
  await page.locator('input[type="file"]').setInputFiles(charts);
  await page.locator(".thumb").nth(2).waitFor();
  const labels = await page.locator(".thumb select").evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value));
  assert.deepEqual(labels, ["4h", "1h", "15m"], "timeframes guessed from filenames and sorted high -> low");
  await page.getByLabel("Symbol (optional)").fill("TESTUSD");
  await page.screenshot({ path: path.join(screens, "1-dashboard-upload.png") });
  await page.getByRole("button", { name: "Analyse charts" }).click();

  step("wait for analysis");
  await page.waitForURL(/\/analysis\//);
  await page.getByText("AI Market Analysis").waitFor({ timeout: realAi ? 15 * 60_000 : 30_000 });
  const decision = await page.locator(".report-head .badge.large").innerText();
  console.log(`  decision: ${decision}`);

  if (!realAi) {
    assert.match(decision, /POTENTIAL LONG/);
    await page.getByText("Risking").waitFor(); // position sizing available (balance + point value)
    const sizing = await page.locator(".sizing").innerText();
    assert.match(sizing, /\$100/, "1% of 10,000");

    step("check annotation placement");
    const shapes = await page.locator(".annotator").first().locator("svg.overlay g").count();
    assert.ok(shapes >= 8, `expected annotations, got ${shapes}`);
    // The SL (100.4) must sit where 100.4 is on the synthetic chart's axis.
    const slY = await page
      .locator(".annotator")
      .first()
      .locator("svg.overlay g", { hasText: "SL 100.4" })
      .locator("line")
      .getAttribute("y1");
    const expected = (0.1 + ((110 - 100.4) / 10) * 0.8) * CHART_H;
    assert.ok(Math.abs(Number(slY) - expected) < 1, `SL line at ${slY}, expected ${expected}`);

    step("layer toggle hides trade levels");
    await page.locator(".annotator").first().getByLabel("Entry / SL / TP").uncheck();
    assert.equal(await page.locator(".annotator").first().locator("svg.overlay g", { hasText: "SL 100.4" }).count(), 0);
    await page.locator(".annotator").first().getByLabel("Entry / SL / TP").check();
  }
  await page.screenshot({ path: path.join(screens, "2-analysis.png"), fullPage: false });

  step("record trade outcome");
  await page.getByLabel("I took this trade manually").check();
  await page.getByLabel("Result (P&L in account currency)").fill("-50");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved.").waitFor();

  step("history + duplicate detection");
  await nav("Dashboard").click();
  await page.getByText("Trades taken").waitFor();
  assert.match(await page.locator(".risk").innerText(), /1 \/ 3/);
  await page.locator('input[type="file"]').setInputFiles(charts);
  await page.locator(".thumb").nth(2).waitFor();
  await page.getByLabel("Symbol (optional)").fill("TESTUSD");
  await page.getByRole("button", { name: "Analyse charts" }).click();
  await page.getByText("These exact screenshots were already analysed").waitFor();
  await nav("History").click();
  await page.getByRole("heading", { name: "Analysis history" }).waitFor();
  await page.locator("table.table tbody tr").first().waitFor();
  assert.equal(await page.locator("table.table tbody tr").count(), 1);
  await page.screenshot({ path: path.join(screens, "3-history.png") });

  step("watchlist status updated from analysis");
  await nav("Watchlist").click();
  if (!realAi) await page.locator(".badge.watch-strong_setup").first().waitFor();
  await page.screenshot({ path: path.join(screens, "4-watchlist.png") });

  step("mobile layout");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Dashboard").click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `horizontal overflow on mobile: ${overflow}px`);
  await page.screenshot({ path: path.join(screens, "5-mobile-dashboard.png"), fullPage: true });

  // The initial session probe (/api/auth/me) legitimately returns 401 before sign-in.
  const relevant = errors.filter((e) => !/favicon/.test(e) && !/status of 401/.test(e));
  assert.deepEqual(relevant, [], "no browser errors");
  console.log("E2E passed. Screenshots in e2e/output/screens");
} catch (err) {
  failed = true;
  console.error(err);
  if (page) await page.screenshot({ path: path.join(screens, "failure.png"), fullPage: true }).catch(() => undefined);
  if (errors.length) console.error("Browser errors:\n" + errors.join("\n"));
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
