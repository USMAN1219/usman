/**
 * Records a video walkthrough of the built app (npm run build first):
 *   npx tsx e2e/record-demo.ts        -> e2e/output/demo/*.webm + screenshots
 * Uses the mock AI unless AI_PROVIDER/GEMINI_API_KEY are set in the environment.
 */
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { chromium } from "playwright-core";
import { generateCharts } from "./generate-charts.ts";

Object.assign(process.env, {
  APP_ENV: "development",
  DB_DRIVER: "memory",
  STORAGE_DRIVER: "memory",
  ANALYSIS_EXECUTION: "async",
  AI_PROVIDER: process.env.AI_PROVIDER ?? "mock",
});
const { createApp } = await import("../server/http/app.ts");

const out = path.resolve("e2e/output/demo");
await mkdir(out, { recursive: true });
const root = new Hono();
const api = createApp();
root.all("/api/*", (c) => api.fetch(c.req.raw));
root.use("/*", serveStatic({ root: "./dist" }));
root.get("*", serveStatic({ path: "./dist/index.html" }));
const server = serve({ fetch: root.fetch, port: 4600, hostname: "127.0.0.1" });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", slowMo: 120 });
try {
  const charts = await generateCharts(path.resolve("e2e/output/charts"), "XAUUSD", browser);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, recordVideo: { dir: out, size: { width: 1366, height: 820 } } });
  const page = await ctx.newPage();
  const nav = (name: string) => page.locator("nav.nav").getByRole("link", { name, exact: true });
  const shot = (n: string, full = false) => page.screenshot({ path: path.join(out, `${n}.png`), fullPage: full });
  const pause = (ms: number) => page.waitForTimeout(ms);

  await page.goto("http://127.0.0.1:4600/");
  await pause(800);
  await page.getByText("No account? Create one").click();
  await page.getByLabel("Email").pressSequentially("trader@example.com", { delay: 30 });
  await page.getByLabel("Password").pressSequentially("my-secure-pass-1", { delay: 30 });
  await shot("01-signup");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("New analysis").waitFor();
  await pause(800);

  await nav("Settings").click();
  await page.getByLabel("Account balance").fill("5000");
  await pause(500);
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved.").waitFor();
  await pause(600);

  await nav("Watchlist").click();
  await page.getByPlaceholder("EURUSD, XAUUSD, NAS100…").fill("XAUUSD");
  await page.getByPlaceholder("for position sizing").fill("100");
  await page.getByRole("button", { name: "Add" }).click();
  await page.locator("td strong", { hasText: "XAUUSD" }).waitFor();
  await pause(600);

  await nav("Dashboard").click();
  await page.locator('input[type="file"]').setInputFiles(charts);
  await page.locator(".thumb").nth(2).waitFor();
  await page.getByLabel("Symbol (optional)").fill("XAUUSD");
  await pause(900);
  await shot("02-upload");
  await page.getByRole("button", { name: "Analyse charts" }).click();
  await page.waitForURL(/\/analysis\//);
  await page.getByText("AI Market Analysis").waitFor({ timeout: 10 * 60_000 });
  await pause(1500);
  await shot("03-analysis");

  // Scroll through the report.
  const report = page.locator(".report-col");
  for (let i = 0; i < 8; i++) {
    await report.evaluate((el) => el.scrollBy({ top: 420, behavior: "smooth" }));
    await pause(700);
  }
  await shot("04-report-setup");
  await report.evaluate((el) => el.scrollTo({ top: 0 }));

  // Toggle a layer to show interactivity, then scroll to the 15m chart with the sweep/CHOCH markers.
  const first = page.locator(".annotator").first();
  await first.getByLabel("Liquidity & sweeps").uncheck();
  await pause(700);
  await first.getByLabel("Liquidity & sweeps").check();
  await page.locator(".annotator").nth(2).scrollIntoViewIfNeeded();
  await pause(1200);
  await shot("05-15m-chart");

  await nav("History").click();
  await page.getByRole("heading", { name: "Analysis history" }).waitFor();
  await pause(1000);
  await shot("06-history");
  await nav("Watchlist").click();
  await page.locator(".badge.watch-strong_setup, .badge.watch-developing_setup, .badge.watch-watch, .badge.watch-no_setup").first().waitFor();
  await pause(1000);
  await shot("07-watchlist");
  await nav("Dashboard").click();
  await pause(1500);
  await shot("08-dashboard");

  await ctx.close();
  const video = (await readdir(out)).find((f) => f.endsWith(".webm") && f !== "demo.webm");
  if (video) await rename(path.join(out, video), path.join(out, "demo.webm"));
  console.log(`Demo recorded in ${out}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(0);
