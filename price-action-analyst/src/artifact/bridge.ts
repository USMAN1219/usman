/**
 * Instant-link edition: talks to Claude through the claude.ai artifact runtime
 * (`window.claude.use("sample")`), which runs on the VIEWER's own Claude
 * account. No server, no API key. Same prompt, schema and checks as the server.
 */
import { ChartAnalysisSchema, type ChartAnalysis } from "../../shared/analysis-schema.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "../../server/ai/prompt.ts";
import { fromWire, WIRE_JSON_SCHEMA } from "../../server/ai/wire.ts";

/* Minimal local typings for the runtime calls this page makes. */
export interface SampleError {
  code: string;
  message: string;
  text?: string;
}
export interface SampleFn {
  json<T = unknown>(input: string, opts?: Record<string, unknown>): Promise<T>;
  limits(): Promise<{ images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
}
export interface DownloadsNs {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

type ClaudeRuntime = { use(name: string): Promise<unknown> };
const runtime = (): ClaudeRuntime | null => ((window as unknown as { claude?: ClaudeRuntime }).claude ?? null);

export async function getSample(): Promise<SampleFn | null> {
  const c = runtime();
  if (!c?.use) return null;
  return ((await c.use("sample").catch(() => null)) as SampleFn | null) ?? null;
}
export async function getDownloads(): Promise<DownloadsNs | null> {
  const c = runtime();
  if (!c?.use) return null;
  return ((await c.use("downloads").catch(() => null)) as DownloadsNs | null) ?? null;
}

export interface AnalyseInput {
  images: { file: Blob; label: string | null; width: number; height: number }[];
  symbol: string | null;
  notes: string | null;
  minRr: number;
  deep: boolean;
  signal: AbortSignal;
  onProgress: (chars: number) => void;
}

export class AnalyseError extends Error {}

const ERROR_COPY: Record<string, string> = {
  not_granted: "Claude access was not allowed for this page. Reload and choose Allow to analyse charts.",
  sampling_disabled: "Claude is not available for your account here.",
  images_unavailable: "This view cannot send images to Claude. Open the link in the Claude app or claude.ai in a browser.",
  image_rejected: "One of the screenshots was rejected. Use PNG, JPEG or WebP under 20 MB.",
  rate_limited: "You've reached your Claude usage limit for now. Wait a little and try again.",
  session_expired: "Your Claude session expired. Sign in again and reload.",
  refused: "Claude declined this request. Upload trading chart screenshots only.",
  invalid_json: "Claude's answer was incomplete or not in the expected format. Try again, or upload fewer screenshots.",
  empty_completion: "Claude returned nothing. Try again with fewer screenshots.",
  prompt_too_large: "The request was too large. Upload fewer screenshots.",
  upstream_error: "Claude had a temporary problem. Try again.",
};

export async function analyseCharts(sample: SampleFn, input: AnalyseInput): Promise<ChartAnalysis> {
  const labels = input.images.map((img, i) => `Image ${i}${img.label ? ` = ${img.label} chart` : ""}`).join("; ");
  const prompt = [
    SYSTEM_PROMPT,
    "---",
    buildUserPrompt({
      images: input.images.map((img, index) => ({ index, label: img.label, width: img.width, height: img.height })),
      symbolHint: input.symbol,
      notes: input.notes,
      minRr: input.minRr,
    }),
    `The attached images, in order: ${labels}.`,
    "Reply with ONLY one JSON object (no prose, no code fences) that matches this JSON Schema. Include every property; use the not-available conventions in the descriptions instead of omitting anything:",
    JSON.stringify(WIRE_JSON_SCHEMA),
  ].join("\n\n");

  let wire: unknown;
  try {
    wire = await sample.json(prompt, {
      images: input.images.map((i) => i.file),
      modelTier: input.deep ? "complex" : "default",
      signal: input.signal,
      cache: false,
      onText: ({ text }: { text: string }) => input.onProgress(text.length),
    });
  } catch (e) {
    const err = e as SampleError;
    if (err?.code === "cancelled") throw new AnalyseError("Stopped.");
    const code = err?.code ?? "unknown";
    throw new AnalyseError(`${ERROR_COPY[code] ?? ERROR_COPY.upstream_error!} (code: ${code})`);
  }
  const parsed = ChartAnalysisSchema.safeParse(fromWire(ChartAnalysisSchema, wire));
  if (!parsed.success) throw new AnalyseError(ERROR_COPY.invalid_json!);
  return parsed.data;
}

export interface ChartData {
  label: string | null;
  candles: { x: number; o: number; h: number; l: number; c: number }[];
}

/**
 * Text-only analysis: used when the view cannot send images. The page has
 * already measured the candles from the screenshots; Claude gets the numbers.
 */
export async function analyseChartData(
  sample: SampleFn,
  input: Omit<AnalyseInput, "images"> & { charts: ChartData[]; dims: { width: number; height: number }[] },
): Promise<ChartAnalysis> {
  const MAX = 160;
  const blocks = input.charts.map((ch, i) => {
    const rows = ch.candles.slice(-MAX);
    return [
      `Chart ${i}${ch.label ? ` (${ch.label})` : ""}: ${rows.length} candles, oldest first. Columns: x,open,high,low,close`,
      ...rows.map((k) => `${k.x},${k.o},${k.h},${k.l},${k.c}`),
    ].join("\n");
  });
  const prompt = [
    SYSTEM_PROMPT,
    "---",
    buildUserPrompt({
      images: input.dims.map((d, index) => ({ index, label: input.charts[index]?.label ?? null, width: d.width, height: d.height })),
      symbolHint: input.symbol,
      notes: input.notes,
      minRr: input.minRr,
    }),
    [
      "IMPORTANT: no images are attached in this view. Instead, the user's screenshots were measured by the page:",
      "each candle's open/high/low/close was read from the pixels using the user's own two-point price-axis calibration, so values are",
      "accurate to about one pixel of price. Treat each chart below as image <index> in your answer. The current price is the last close",
      "of the lowest timeframe. The x column is the candle's horizontal position (fraction of the screenshot width): use those values for",
      "x and x_start fields. Return an empty calibrations array (the page already knows the price axis). Readability: price scale and",
      "timeframe come from the user; do not report them as unreadable. Indicators are not present in this data.",
    ].join(" "),
    blocks.join("\n\n"),
    "Reply with ONLY one JSON object (no prose, no code fences) that matches this JSON Schema. Include every property; use the not-available conventions in the descriptions instead of omitting anything:",
    JSON.stringify(WIRE_JSON_SCHEMA),
  ].join("\n\n");

  let wire: unknown;
  try {
    wire = await sample.json(prompt, {
      modelTier: input.deep ? "complex" : "default",
      signal: input.signal,
      cache: false,
      onText: ({ text }: { text: string }) => input.onProgress(text.length),
    });
  } catch (e) {
    const err = e as SampleError;
    if (err?.code === "cancelled") throw new AnalyseError("Stopped.");
    const code = err?.code ?? "unknown";
    throw new AnalyseError(`${ERROR_COPY[code] ?? ERROR_COPY.upstream_error!} (code: ${code})`);
  }
  const parsed = ChartAnalysisSchema.safeParse(fromWire(ChartAnalysisSchema, wire));
  if (!parsed.success) throw new AnalyseError(ERROR_COPY.invalid_json!);
  return parsed.data;
}
