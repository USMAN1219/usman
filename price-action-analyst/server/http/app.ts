/**
 * The HTTP API. Framework-agnostic (Web Request/Response), so the same app
 * runs as a Netlify Function in production and as a Node server locally.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { tooLarge, notFound } from "../errors.ts";
import { getServices, type Services } from "../services.ts";
import { accountRoutes } from "./routes/account.ts";
import { analysisRoutes } from "./routes/analyses.ts";
import { authRoutes } from "./routes/auth.ts";
import { apiHeaders, csrfGuard, errorResponse, type Env } from "./middleware.ts";

export const DISCLAIMER =
  "AI analysis is probabilistic and may be wrong. Always independently verify the chart before taking any trade.";

export function createApp(resolveServices: () => Services = getServices) {
  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => errorResponse(c, notFound("Unknown API route.")));
  app.use("*", apiHeaders);
  app.use("*", async (c, next) => {
    const services = resolveServices();
    c.set("services", services);
    if (c.req.path !== "/api/health") await services.ready();
    await next();
  });
  app.use("*", csrfGuard);
  app.use("*", async (c, next) => {
    const max = c.get("services").config.MAX_TOTAL_UPLOAD_BYTES + 512 * 1024;
    return bodyLimit({ maxSize: max, onError: () => { throw tooLarge("Upload is too large."); } })(c, next);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/config", (c) => {
    const { config } = c.get("services");
    return c.json({
      registrationEnabled: config.REGISTRATION_ENABLED,
      inviteRequired: !!config.REGISTRATION_INVITE_CODE,
      maxImages: config.MAX_IMAGES,
      maxImageBytes: config.MAX_IMAGE_BYTES,
      maxTotalBytes: config.MAX_TOTAL_UPLOAD_BYTES,
      aiProvider: config.AI_PROVIDER,
      model: config.AI_PROVIDER === "mock" ? "mock" : config.AI_PROVIDER === "gemini" ? config.GEMINI_MODEL : config.ANTHROPIC_MODEL,
      pricing: config.pricing,
      disclaimer: DISCLAIMER,
    });
  });

  app.route("/auth", authRoutes);
  app.route("/analyses", analysisRoutes);
  app.route("/", accountRoutes);
  return app;
}
