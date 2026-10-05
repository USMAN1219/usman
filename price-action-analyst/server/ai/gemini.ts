/**
 * Free AI option: Google Gemini API (vision) via its REST endpoint.
 *
 * A key from Google AI Studio (aistudio.google.com) gives free-tier access to
 * Gemini Flash models without a credit card, within Google's rate limits.
 * Note: on the free tier Google may use prompts and images to improve its
 * products - do not upload anything private.
 *
 * Uses the same system prompt, wire schema, validation and guardrails as the
 * Claude analyzer, so the rest of the app does not care which model ran.
 */
import { ChartAnalysisSchema } from "../../shared/analysis-schema.ts";
import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { AnalysisError, estimateCost, WIRE_JSON_SCHEMA, type AnalyzerInput, type AnalyzerOutput, type ChartAnalyzer } from "./analyzer.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import { fromWire } from "./wire.ts";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

type Json = Record<string, unknown>;

/** Converts our strict JSON Schema into Gemini's OpenAPI-style responseSchema (refs inlined). */
export function toGeminiSchema(node: unknown, defs: Json = (WIRE_JSON_SCHEMA.$defs as Json) ?? {}): Json {
  const n = node as Json;
  if (typeof n.$ref === "string") return toGeminiSchema(defs[n.$ref.split("/").pop()!], defs);
  const out: Json = { type: String(n.type).toUpperCase() };
  if (typeof n.description === "string") out.description = n.description;
  if (Array.isArray(n.enum)) out.enum = n.enum;
  if (n.type === "object") {
    const props = (n.properties as Json) ?? {};
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v, defs)]));
    out.required = Object.keys(props);
    out.propertyOrdering = Object.keys(props);
  }
  if (n.type === "array" && n.items) out.items = toGeminiSchema(n.items, defs);
  return out;
}

const GEMINI_SCHEMA = toGeminiSchema(WIRE_JSON_SCHEMA);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiChartAnalyzer implements ChartAnalyzer {
  constructor(
    private readonly config: AppConfig,
    private readonly baseUrl = DEFAULT_BASE,
  ) {}

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const cfg = this.config;
    const started = Date.now();
    const parts: Json[] = [];
    input.images.forEach((img, index) => {
      parts.push({ text: `Image ${index}${img.label ? ` (user label: ${img.label})` : ""}:` });
      parts.push({ inlineData: { mimeType: img.mime, data: Buffer.from(img.data).toString("base64") } });
    });
    parts.push({
      text: buildUserPrompt({
        images: input.images.map((img, index) => ({ index, label: img.label, width: img.width, height: img.height })),
        symbolHint: input.symbolHint,
        notes: input.notes,
        minRr: input.minRr,
      }),
    });

    let res: GeminiResponse;
    try {
      res = await this.call(parts, true);
    } catch (err) {
      // Large schemas can exceed Gemini's constrained-decoding limits; fall back to JSON mode + schema in the prompt.
      if (err instanceof SchemaRejected) {
        log.warn("analysis.gemini_schema_rejected", { message: err.message });
        res = await this.call([...parts, { text: jsonInstruction() }], false);
      } else throw err;
    }

    const u = res.usageMetadata ?? {};
    const tokens = {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cacheReadTokens: u.cachedContentTokenCount ?? 0,
      cacheWriteTokens: 0,
    };
    const usage = {
      model: res.modelVersion ?? cfg.GEMINI_MODEL,
      ...tokens,
      costUsd: estimateCost(cfg.pricing, tokens),
      durationMs: Date.now() - started,
    };
    const cand = res.candidates?.[0];
    log.info("analysis.model_response", { provider: "gemini", model: usage.model, finish: cand?.finishReason, ...tokens, ms: usage.durationMs });

    if (res.promptFeedback?.blockReason || cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") {
      throw new AnalysisError("The AI model declined to analyse these images. Please upload trading chart screenshots only.", false);
    }
    if (cand?.finishReason === "MAX_TOKENS") {
      throw new AnalysisError("The analysis was cut off before completing. Try fewer screenshots.", true);
    }
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/, "");
    let wire: unknown = null;
    try {
      wire = JSON.parse(text);
    } catch {
      wire = null;
    }
    const validated = ChartAnalysisSchema.safeParse(fromWire(ChartAnalysisSchema, wire));
    if (!validated.success) {
      log.error("analysis.schema_mismatch", { provider: "gemini", issues: validated.error.issues.slice(0, 5) });
      throw new AnalysisError("The AI response did not match the expected analysis format. Please try again.", true);
    }
    return { analysis: validated.data, usage };
  }

  private async call(parts: Json[], structured: boolean): Promise<GeminiResponse> {
    const cfg = this.config;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        ...(structured ? { responseSchema: GEMINI_SCHEMA } : {}),
        maxOutputTokens: 32768,
      },
    };
    // Keep inside Netlify's 60 s synchronous limit when running inline; longer in background mode.
    const timeout = cfg.GEMINI_TIMEOUT_MS ?? (cfg.ANALYSIS_EXECUTION === "inline" ? 52_000 : 600_000);
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}/models/${encodeURIComponent(cfg.GEMINI_MODEL)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": cfg.GEMINI_API_KEY ?? "" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new AnalysisError("The AI took too long to respond. Try fewer screenshots or try again.", true);
      throw new AnalysisError("Could not reach the AI service. Please try again.", true);
    }
    const data = (await r.json().catch(() => ({}))) as GeminiResponse;
    if (r.ok) return data;

    const msg = data.error?.message ?? `HTTP ${r.status}`;
    log.error("analysis.gemini_error", { status: r.status, apiStatus: data.error?.status, message: msg.slice(0, 300) });
    if (r.status === 429)
      throw new AnalysisError("Free AI limit reached (Gemini free tier allows only a few requests per minute and per day). Wait a minute and retry, or try again tomorrow.", true);
    if (r.status === 400 && /api key|API_KEY/i.test(msg)) throw new AnalysisError("The AI service is not configured correctly (Gemini API key rejected). Contact the operator.", false);
    if (r.status === 400 && structured && /schema|response_schema|responseSchema|too many states|constraint/i.test(msg)) throw new SchemaRejected(msg);
    if (r.status === 401 || r.status === 403) throw new AnalysisError("The AI service is not configured correctly (Gemini API key not permitted). Contact the operator.", false);
    if (r.status === 404) throw new AnalysisError(`The configured Gemini model "${cfg.GEMINI_MODEL}" was not found. Set GEMINI_MODEL to a current Flash model.`, false);
    if (r.status >= 500) throw new AnalysisError("The AI service is temporarily unavailable. Please try again shortly.", true);
    throw new AnalysisError("The AI service rejected the request. Try different screenshots (PNG/JPEG/WebP charts).", false);
  }
}

class SchemaRejected extends Error {}

function jsonInstruction() {
  return `Respond with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema exactly, including every property:\n${JSON.stringify(WIRE_JSON_SCHEMA)}`;
}
