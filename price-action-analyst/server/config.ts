/**
 * Environment configuration, validated once at startup.
 *
 * Secrets are only ever read here, on the server. Nothing in this module is
 * imported by the frontend bundle.
 */
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : Number(v)))
    .pipe(z.number().finite());
const optionalNum = z
  .string()
  .optional()
  .transform((v) => (v == null || v === "" ? null : Number(v)))
  .pipe(z.number().finite().nullable());

/** Published Claude API prices in USD per million tokens (input, output). Override with env vars. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const EnvSchema = z.object({
  // Secure by default: anything not explicitly development/test is treated as production.
  APP_ENV: z.enum(["production", "development", "test"]).default("production"),
  APP_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: num(24 * 7),
  REGISTRATION_ENABLED: bool(true),
  REGISTRATION_INVITE_CODE: z.string().optional(),

  DB_DRIVER: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.string().optional(),

  STORAGE_DRIVER: z.enum(["netlify", "fs", "memory"]).default("netlify"),
  FS_STORAGE_DIR: z.string().default(".data/uploads"),

  // gemini = Google Gemini API free tier (no card needed); anthropic = Claude (paid); mock = fake results.
  AI_PROVIDER: z.enum(["gemini", "anthropic", "mock"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  GEMINI_TIMEOUT_MS: optionalNum,
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  ANTHROPIC_MAX_TOKENS: num(32000),
  ANTHROPIC_FALLBACKS: bool(true),
  ANTHROPIC_TIMEOUT_MS: num(12 * 60 * 1000),
  AI_PRICE_INPUT_PER_MTOK: optionalNum,
  AI_PRICE_OUTPUT_PER_MTOK: optionalNum,

  // background = Netlify Background Function; async = in-process without waiting (long-running Node server only);
  // inline = finish before responding (tests / scripts).
  ANALYSIS_EXECUTION: z.enum(["background", "async", "inline"]).default("inline"),
  INTERNAL_JOB_SECRET: z.string().optional(),

  RATE_LIMIT_ANALYSES_PER_HOUR: num(10),
  RATE_LIMIT_ANALYSES_PER_DAY: num(40),
  MONTHLY_BUDGET_USD: optionalNum,
  LOGIN_ATTEMPTS_PER_15_MIN: num(10),
  DUPLICATE_WINDOW_HOURS: num(24),
  AUTO_MIGRATE: bool(true),

  MAX_IMAGES: num(6),
  MAX_IMAGE_BYTES: num(1_500_000),
  MAX_TOTAL_UPLOAD_BYTES: num(4_500_000),
  MIN_IMAGE_DIMENSION: num(300),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends RawEnv {
  isProduction: boolean;
  authSecret: string;
  pricing: { input: number; output: number };
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Netlify exposes the deploy's public URL as URL; use it when APP_URL is not set.
  const merged = { ...env, APP_URL: env.APP_URL || env.URL || undefined };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.APP_ENV === "production";
  const problems: string[] = [];

  let authSecret = c.AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    if (isProduction) problems.push("AUTH_SECRET must be set to a random string of at least 32 characters.");
    else authSecret = "development-only-insecure-secret-change-me-0123456789";
  }
  if (c.DB_DRIVER === "postgres" && !c.DATABASE_URL) problems.push("DATABASE_URL is required when DB_DRIVER=postgres.");
  if (c.AI_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY && isProduction)
    problems.push("ANTHROPIC_API_KEY is required in production when AI_PROVIDER=anthropic.");
  if (c.AI_PROVIDER === "gemini" && !c.GEMINI_API_KEY && isProduction)
    problems.push("GEMINI_API_KEY is required in production when AI_PROVIDER=gemini (free key: aistudio.google.com).");
  if (c.ANALYSIS_EXECUTION === "background" && (c.INTERNAL_JOB_SECRET ?? "").length < 32)
    problems.push("INTERNAL_JOB_SECRET (32+ characters) is required when ANALYSIS_EXECUTION=background.");
  if (isProduction) {
    if (c.DB_DRIVER === "memory") problems.push("DB_DRIVER=memory is not allowed in production.");
    if (c.STORAGE_DRIVER === "memory") problems.push("STORAGE_DRIVER=memory is not allowed in production.");
    if (c.AI_PROVIDER === "mock") problems.push("AI_PROVIDER=mock is not allowed in production.");
    if (c.ANALYSIS_EXECUTION === "async")
      problems.push("ANALYSIS_EXECUTION=async is for long-running local servers only; use 'background' (or 'inline') on Netlify.");
  }
  if (problems.length) throw new ConfigError(problems.join(" "));

  // Gemini free tier costs nothing; set AI_PRICE_* if you move to a paid Gemini tier.
  const known = c.AI_PROVIDER === "anthropic" ? (MODEL_PRICING[c.ANTHROPIC_MODEL] ?? { input: 0, output: 0 }) : { input: 0, output: 0 };
  return {
    ...c,
    isProduction,
    authSecret,
    pricing: {
      input: c.AI_PRICE_INPUT_PER_MTOK ?? known.input,
      output: c.AI_PRICE_OUTPUT_PER_MTOK ?? known.output,
    },
  };
}
