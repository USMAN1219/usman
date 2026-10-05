/**
 * Command-line check of the real AI pipeline on local screenshots, without the web app.
 *   npm run analyze:file -- --symbol EURUSD 4h=charts/eu-4h.png 15m=charts/eu-15m.png
 * Requires GEMINI_API_KEY (free) or AI_PROVIDER=anthropic with ANTHROPIC_API_KEY. Prints the guardrailed decision, levels, R:R and cost.
 */
import { readFile } from "node:fs/promises";
import { ClaudeChartAnalyzer } from "../ai/analyzer.ts";
import { GeminiChartAnalyzer } from "../ai/gemini.ts";
import { validateImages } from "../analysis/images.ts";
import { applyGuardrails } from "../analysis/guardrails.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_SETTINGS } from "../../shared/types.ts";

const args = process.argv.slice(2);
let symbol: string | null = null;
const inputs: { label: string | null; path: string }[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--symbol") symbol = args[++i] ?? null;
  else if (a.includes("=")) {
    const [label, path] = a.split("=", 2) as [string, string];
    inputs.push({ label, path });
  } else inputs.push({ label: null, path: a });
}
if (!inputs.length) {
  console.error("Usage: npm run analyze:file -- [--symbol SYM] [label=]image.png ...");
  process.exit(1);
}

const config = loadConfig({ APP_ENV: "development", ...process.env, ANALYSIS_EXECUTION: "async", DB_DRIVER: "memory", STORAGE_DRIVER: "memory" });
const files = await Promise.all(inputs.map(async (f) => ({ data: new Uint8Array(await readFile(f.path)), label: f.label })));
const images = validateImages(files, { ...config, MAX_IMAGE_BYTES: 5_000_000, MAX_TOTAL_UPLOAD_BYTES: 30_000_000 });
const useGemini = config.AI_PROVIDER !== "anthropic";
console.log(`Analysing ${images.length} image(s) with ${useGemini ? config.GEMINI_MODEL : config.ANTHROPIC_MODEL}...`);
const analyzer = useGemini ? new GeminiChartAnalyzer(config) : new ClaudeChartAnalyzer(config);
const { analysis, usage } = await analyzer.analyze({
  images: images.map((i) => ({ data: i.data, mime: i.mime, label: i.label, width: i.width, height: i.height })),
  symbolHint: symbol,
  notes: null,
  minRr: DEFAULT_SETTINGS.minRr,
});
const derived = applyGuardrails({ analysis, settings: DEFAULT_SETTINGS, pointValue: null });
console.log(JSON.stringify({ decision: derived.finalDecision, grade: derived.grade, setup: analysis.setup, rr: derived.rr, guardrailNotes: derived.guardrailNotes, warnings: derived.complianceWarnings, readability: analysis.readability_issues, usage }, null, 2));
if (process.argv.includes("--full")) console.log(JSON.stringify(analysis, null, 2));
