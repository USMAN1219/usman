/** GeminiChartAnalyzer against a local fake of the Gemini generateContent REST API. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeminiChartAnalyzer, toGeminiSchema } from "../server/ai/gemini.ts";
import { WIRE_JSON_SCHEMA } from "../server/ai/analyzer.ts";
import { mockAnalysis } from "../server/ai/mock.ts";
import { loadConfig } from "../server/config.ts";
import { makePng } from "./helpers.ts";

type Reply = { status?: number; body: unknown };
let server: Server;
let base = "";
const requests: { url: string; headers: Record<string, unknown>; body: any }[] = [];
const replies: Reply[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
    const r = replies.shift() ?? { body: {} };
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
});
afterAll(() => server.close());

const config = loadConfig({ APP_ENV: "test", DB_DRIVER: "memory", AI_PROVIDER: "gemini", GEMINI_API_KEY: "g-key", ANALYSIS_EXECUTION: "inline" });
const analyzer = () => new GeminiChartAnalyzer(config, base);
const input = () => ({
  images: [{ data: makePng(640, 400), mime: "image/png" as const, label: "1h", width: 640, height: 400 }],
  symbolHint: "XAUUSD",
  notes: null,
  minRr: 2,
});
function wire() {
  const a: any = mockAnalysis(input());
  a.setup.tp3 = -1;
  a.levels[0].price_high = -1;
  return a;
}
const ok = (text: string, finishReason = "STOP") => ({
  candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 1500, thoughtsTokenCount: 500 },
  modelVersion: "gemini-flash-test",
});

describe("GeminiChartAnalyzer", () => {
  it("builds an OpenAPI-style schema Gemini accepts (no refs, unions or additionalProperties)", () => {
    const s = JSON.stringify(toGeminiSchema(WIRE_JSON_SCHEMA));
    expect(s).not.toMatch(/\$ref|\$defs|anyOf|additionalProperties/);
    const g: any = toGeminiSchema(WIRE_JSON_SCHEMA);
    expect(g.type).toBe("OBJECT");
    expect(g.properties.setup.properties.direction.enum).toEqual(["long", "short", "no_trade"]);
    expect(g.properties.setup.properties.entry_low.type).toBe("NUMBER");
  });

  it("sends images + system prompt + schema, ignores thought parts, converts sentinels, costs $0 on free tier", async () => {
    replies.push({ body: ok(JSON.stringify(wire())) });
    const out = await analyzer().analyze(input());
    const req = requests.at(-1)!;
    expect(req.url).toBe("/v1beta/models/gemini-flash-latest:generateContent");
    expect(req.headers["x-goog-api-key"]).toBe("g-key");
    expect(req.body.systemInstruction.parts[0].text).toMatch(/price-action analyst/);
    expect(req.body.contents[0].parts.some((p: any) => p.inlineData?.mimeType === "image/png")).toBe(true);
    expect(req.body.generationConfig.responseMimeType).toBe("application/json");
    expect(req.body.generationConfig.responseSchema.type).toBe("OBJECT");
    expect(out.analysis.setup.tp3).toBeNull();
    expect(out.analysis.setup.stop_loss).toBe(100.4);
    expect(out.usage).toMatchObject({ model: "gemini-flash-test", inputTokens: 2000, outputTokens: 2000, costUsd: 0 });
  });

  it("falls back to JSON mode when the schema is rejected, and tolerates omitted empty lists", async () => {
    replies.push({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "The specified schema produces a constraint that has too many states for serving." } } });
    const w = wire();
    delete w.order_blocks;
    delete w.liquidity.sweeps;
    replies.push({ body: ok("```json\n" + JSON.stringify(w) + "\n```") });
    const out = await analyzer().analyze(input());
    expect(out.analysis.order_blocks).toEqual([]);
    const last = requests.at(-1)!.body;
    expect(last.generationConfig.responseSchema).toBeUndefined();
    expect(last.contents[0].parts.at(-1).text).toMatch(/Respond with ONLY a JSON object/);
  });

  it("explains free-tier limits, bad keys, blocked content and truncation", async () => {
    replies.push({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } } });
    await expect(analyzer().analyze(input())).rejects.toThrow(/Free AI limit reached/);
    replies.push({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } } });
    await expect(analyzer().analyze(input())).rejects.toThrow(/API key rejected/);
    replies.push({ body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(analyzer().analyze(input())).rejects.toThrow(/declined/);
    replies.push({ body: ok('{"charts":', "MAX_TOKENS") });
    await expect(analyzer().analyze(input())).rejects.toThrow(/cut off/);
    replies.push({ status: 404, body: { error: { code: 404, message: "models/x is not found" } } });
    await expect(analyzer().analyze(input())).rejects.toThrow(/GEMINI_MODEL/);
  });

  it("requires a Gemini key in production", () => {
    expect(() =>
      loadConfig({ APP_ENV: "production", APP_URL: "https://x.netlify.app", AUTH_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x", AI_PROVIDER: "gemini", ANALYSIS_EXECUTION: "inline" }),
    ).toThrow(/GEMINI_API_KEY/);
  });
});
