/**
 * Checks the instant-link page (npm run build:instant first) in Chromium with a
 * simulated claude.ai runtime: example renders, upload -> analyse -> result,
 * history, settings, phone width, dark theme. No real Claude usage.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { mockAnalysis } from "../server/ai/mock.ts";

const out = path.resolve("e2e/output/instant");
await mkdir(out, { recursive: true });
const body = await readFile("dist-artifact/price-action-analyst.html", "utf8");
// Same skeleton the artifact host wraps the page in.
const page_html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;

// What the model would return (wire format: sentinels instead of nulls).
const wire: any = mockAnalysis({ images: [{ data: new Uint8Array(), mime: "image/png", label: "1h", width: 1400, height: 800 }], symbolHint: "XAUUSD", notes: null });
wire.setup.tp3 = -1;
wire.levels.forEach((l: any) => (l.price_high = -1));

const stub = (answer: unknown) => `
  window.__calls = [];
  window.claude = { use: async (name) => {
    if (name === "sample") {
      const fn = async () => ({ text: "" });
      fn.json = async (input, opts) => {
        window.__calls.push({ len: input.length, images: opts.images.length, tier: opts.modelTier });
        await new Promise((r) => setTimeout(r, 1500));
        opts.onText({ text: "{", delta: "{" });
        return ${JSON.stringify(answer)};
      };
      fn.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20000000, mediaTypes: ["image/png","image/jpeg","image/webp"] } });
      return fn;
    }
    if (name === "downloads") return { save: async () => ({ status: "saved" }) };
    return null;
  } };`;

// Serve from a real origin (like the artifact host) so browser storage works.
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page_html);
});
await new Promise<void>((r) => server.listen(4610, "127.0.0.1", r));
const URL_ = "http://127.0.0.1:4610/";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  await ctx.addInitScript(stub(wire));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await page.getByText("Example result").waitFor();
  assert.ok((await page.locator("svg.overlay g").count()) > 5, "example annotations drawn");
  await page.screenshot({ path: path.join(out, "1-first-view.png") });

  await page.locator("#chart-files").setInputFiles(["e2e/output/charts/XAUUSD_4h.png", "e2e/output/charts/XAUUSD_1h.png"]);
  await page.locator(".thumb").nth(1).waitFor();
  await page.locator("#symbol").fill("xauusd");
  await page.getByRole("button", { name: "Analyse charts" }).click();
  await page.getByText(/Claude is reading the charts|Writing the analysis/).waitFor();
  await page.screenshot({ path: path.join(out, "2-running.png") });
  // The saved result view (unlike the example) has a Delete button.
  await page.getByRole("button", { name: "Delete" }).waitFor();
  const calls = await page.evaluate(() => (window as any).__calls);
  assert.equal(calls[0].images, 2);
  assert.equal(calls[0].tier, "default");
  assert.ok(calls[0].len > 20000, "prompt contains system prompt + schema");
  assert.match(await page.locator(".report-head").innerText(), /POTENTIAL LONG/);
  await page.screenshot({ path: path.join(out, "3-result.png") });

  await page.getByRole("button", { name: /History/ }).click();
  await page.locator(".history-row").first().waitFor();
  assert.equal(await page.locator(".history-row").count(), 1);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#balance").fill("5000");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Saved. Applies to new analyses.").waitFor();

  // Reload: history persists in this browser.
  await page.goto(URL_);
  await page.getByRole("button", { name: "History (1)" }).waitFor();

  for (const [w, theme] of [[390, "dark"], [390, "light"]] as const) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.getByRole("button", { name: "History (1)" }).click();
    await page.locator(".history-row").click();
    await page.getByRole("button", { name: "Delete" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px at ${w}px`);
    await page.screenshot({ path: path.join(out, `4-phone-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log("Instant page check passed:", out);
} finally {
  await browser.close();
  server.close();
}
