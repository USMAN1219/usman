import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.ts";

describe("production config", () => {
  const free = { AUTH_SECRET: "s".repeat(40), DATABASE_URL: "postgres://u:p@h/db?sslmode=require", GEMINI_API_KEY: "AIza-test" };

  it("starts with only the four variables from docs/FREE_SETUP.md, using safe free defaults", () => {
    const c = loadConfig(free);
    expect(c).toMatchObject({ isProduction: true, AI_PROVIDER: "gemini", DB_DRIVER: "postgres", STORAGE_DRIVER: "netlify", ANALYSIS_EXECUTION: "inline", AUTO_MIGRATE: true });
    expect(c.pricing).toEqual({ input: 0, output: 0 });
  });

  it("is secure by default: refuses missing or weak secrets and unsafe drivers", () => {
    expect(() => loadConfig({ ...free, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ ...free, GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({ ...free, AI_PROVIDER: "mock" })).toThrow(/mock/);
    expect(() => loadConfig({ ...free, DB_DRIVER: "memory" })).toThrow(/memory/);
    expect(() => loadConfig({ ...free, ANALYSIS_EXECUTION: "background" })).toThrow(/INTERNAL_JOB_SECRET/);
    expect(() => loadConfig({ ...free, AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
