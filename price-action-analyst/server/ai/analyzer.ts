/**
 * AI layer: sends chart screenshots to a vision-capable Claude model and gets
 * back a schema-validated ChartAnalysis.
 *
 * The deployed app talks to the Anthropic API directly with its own API key.
 * It does not depend on Claude Code (or any developer tool) being installed,
 * open, or subscribed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ChartAnalysisSchema, type ChartAnalysis } from "../../shared/analysis-schema.ts";
import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import { toStrictJsonSchema } from "./json-schema.ts";
import { fromWire, toWireSchema } from "./wire.ts";

/** Union-free schema actually sent to the API (see wire.ts for why). */
export const WIRE_SCHEMA = toWireSchema(ChartAnalysisSchema);
export const WIRE_JSON_SCHEMA = toStrictJsonSchema(WIRE_SCHEMA);

export interface AnalyzerImage {
  data: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/webp";
  label: string | null;
  width: number;
  height: number;
}

export interface AnalyzerInput {
  images: AnalyzerImage[];
  symbolHint: string | null;
  notes: string | null;
  minRr: number;
}

export interface AnalyzerUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface AnalyzerOutput {
  analysis: ChartAnalysis;
  usage: AnalyzerUsage;
}

export interface ChartAnalyzer {
  analyze(input: AnalyzerInput): Promise<AnalyzerOutput>;
}

/** A failure that should be shown to the user verbatim (no internals). */
export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function estimateCost(
  pricing: { input: number; output: number },
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const usd =
    (u.inputTokens * pricing.input +
      u.outputTokens * pricing.output +
      u.cacheReadTokens * pricing.input * 0.1 +
      u.cacheWriteTokens * pricing.input * 1.25) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export class ClaudeChartAnalyzer implements ChartAnalyzer {
  private readonly client: Anthropic;

  constructor(
    private readonly config: AppConfig,
    client?: Anthropic,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: config.ANTHROPIC_API_KEY,
        timeout: config.ANTHROPIC_TIMEOUT_MS,
        maxRetries: 2,
      });
  }

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const cfg = this.config;
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [];
    input.images.forEach((img, index) => {
      content.push({ type: "text", text: `Image ${index}${img.label ? ` (user label: ${img.label})` : ""}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mime, data: Buffer.from(img.data).toString("base64") },
      });
    });
    content.push({
      type: "text",
      text: buildUserPrompt({
        images: input.images.map((img, index) => ({ index, label: img.label, width: img.width, height: img.height })),
        symbolHint: input.symbolHint,
        notes: input.notes,
        minRr: input.minRr,
      }),
    });

    const supportsAdaptive = !cfg.ANTHROPIC_MODEL.startsWith("claude-haiku");
    const base = {
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: cfg.ANTHROPIC_MAX_TOKENS,
      ...(supportsAdaptive ? { thinking: { type: "adaptive" as const } } : {}),
      // Frozen system prompt marked for caching: repeat analyses pay ~10% for it.
      system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
    };
    const effort = supportsAdaptive ? { effort: cfg.ANTHROPIC_EFFORT } : {};

    // Streaming avoids HTTP timeouts on long, high-effort vision analyses.
    const run = (structured: boolean) => {
      const params = structured
        ? { ...base, output_config: { ...effort, format: { type: "json_schema" as const, schema: WIRE_JSON_SCHEMA } }, messages: [{ role: "user" as const, content }] }
        : {
            ...base,
            ...(supportsAdaptive ? { output_config: effort } : {}),
            messages: [{ role: "user" as const, content: [...content, { type: "text" as const, text: jsonFallbackInstruction() }] }],
          };
      const stream = cfg.ANTHROPIC_FALLBACKS
        ? this.client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : this.client.messages.stream(params);
      return stream.finalMessage();
    };

    let message;
    try {
      try {
        message = await run(true);
      } catch (err) {
        // If the API cannot compile the output schema, fall back to prompt-instructed JSON validated locally.
        if (err instanceof Anthropic.BadRequestError && /schema|grammar|compil/i.test(err.message)) {
          log.warn("analysis.structured_output_unavailable", { message: err.message });
          message = await run(false);
        } else throw err;
      }
    } catch (err) {
      throw mapApiError(err);
    }

    const usage = message.usage;
    const tokens = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
    const result: AnalyzerUsage = {
      model: message.model,
      ...tokens,
      costUsd: estimateCost(cfg.pricing, tokens),
      durationMs: Date.now() - started,
    };
    log.info("analysis.model_response", { model: message.model, stop: message.stop_reason, ...tokens, ms: result.durationMs });

    if (message.stop_reason === "refusal") {
      throw new AnalysisError("The AI model declined to analyse these images. Please upload trading chart screenshots only.", false);
    }
    if (message.stop_reason === "max_tokens") {
      throw new AnalysisError("The analysis was cut off before completing. Try fewer screenshots or ask the operator to raise ANTHROPIC_MAX_TOKENS.", true);
    }

    const wire = parseJsonText(message.content);
    const validated = ChartAnalysisSchema.safeParse(fromWire(ChartAnalysisSchema, wire));
    if (!validated.success) {
      log.error("analysis.schema_mismatch", { issues: validated.error.issues.slice(0, 5) });
      throw new AnalysisError("The AI response did not match the expected analysis format. Please try again.", true);
    }
    return { analysis: validated.data, usage: result };
  }
}

function jsonFallbackInstruction() {
  return `Respond with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema exactly:\n${JSON.stringify(WIRE_JSON_SCHEMA)}`;
}

function parseJsonText(content: Array<{ type: string; text?: string }>): unknown {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapApiError(err: unknown): Error {
  if (err instanceof AnalysisError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    log.error("analysis.api_auth_error", { status: (err as InstanceType<typeof Anthropic.APIError>).status });
    return new AnalysisError("The AI service is not configured correctly (API key rejected). Contact the operator.", false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AnalysisError("The AI service is busy (rate limited). Please try again in a minute.", true);
  }
  if (err instanceof Anthropic.BadRequestError) {
    log.error("analysis.api_bad_request", { message: err.message });
    const lowCredit = /credit|billing|balance/i.test(err.message);
    return new AnalysisError(
      lowCredit
        ? "The AI service account has insufficient credit. The operator must top up the Anthropic API account."
        : "The AI service rejected the request. Try different screenshots (PNG/JPEG/WebP charts).",
      false,
    );
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionError) {
    return new AnalysisError("Could not reach the AI service. Please try again.", true);
  }
  if (err instanceof Anthropic.APIError) {
    log.error("analysis.api_error", { status: err.status, message: err.message });
    return new AnalysisError("The AI service returned an error. Please try again shortly.", true);
  }
  log.error("analysis.unexpected_error", { message: err instanceof Error ? err.message : String(err) });
  return new AnalysisError("Unexpected error while analysing the chart.", true);
}
