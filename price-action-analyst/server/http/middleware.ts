import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { ZodError } from "zod";
import { verifySessionToken, SESSION_COOKIE } from "../auth/session.ts";
import { ConfigError } from "../config.ts";
import { AppError, forbidden, unauthorized } from "../errors.ts";
import { log } from "../logger.ts";
import type { Services } from "../services.ts";
import type { ApiErrorBody, PublicUser } from "../../shared/types.ts";

export type Env = { Variables: { services: Services; user: PublicUser } };

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details } };
    const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) c.header("Retry-After", String(retry));
    return c.json(body, err.status as 400);
  }
  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: "validation_error",
        message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      },
    };
    return c.json(body, 400);
  }
  if (err instanceof ConfigError) {
    // Names which setting is missing/invalid (never its value) so the operator can fix it in Netlify.
    log.error("config.invalid", { message: err.message });
    return c.json({ error: { code: "server_not_configured", message: `Server setup problem: ${err.message}` } } satisfies ApiErrorBody, 503);
  }
  log.error("http.unhandled_error", { path: c.req.path, error: err instanceof Error ? err.stack : String(err) });
  return c.json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } } satisfies ApiErrorBody, 500);
}

/** API responses are private and never cached by shared caches. */
export const apiHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
};

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. a custom header that cross-site HTML forms cannot send, and
 *  2. if the browser sends Origin, it must match this site.
 * No CORS headers are ever emitted, so other origins cannot read responses.
 */
export const csrfGuard: MiddlewareHandler<Env> = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (c.req.header("x-requested-with") !== "fetch") throw forbidden("Missing request header.");
  const origin = c.req.header("origin");
  if (origin) {
    const cfg = c.get("services").config;
    const allowed = new Set([new URL(c.req.url).origin]);
    if (cfg.APP_URL) allowed.add(new URL(cfg.APP_URL).origin);
    if (!allowed.has(origin)) throw forbidden("Cross-origin request rejected.");
  }
  return next();
};

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const services = c.get("services");
  const userId = token ? await verifySessionToken(token, services.config.authSecret) : null;
  if (!userId) throw unauthorized();
  const user = await services.repo.findUserById(userId);
  if (!user) throw unauthorized();
  c.set("user", { id: user.id, email: user.email });
  return next();
};

export function clientIp(c: Context): string {
  return (
    c.req.header("x-nf-client-connection-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
