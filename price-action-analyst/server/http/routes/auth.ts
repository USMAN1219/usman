import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { getDummyHash, hashPassword, verifyPassword } from "../../auth/password.ts";
import { createSessionToken, SESSION_COOKIE } from "../../auth/session.ts";
import { conflict, forbidden, unauthorized } from "../../errors.ts";
import { enforceRateLimit } from "../../rate-limit.ts";
import { clientIp, requireUser, type Env } from "../middleware.ts";

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters.").max(200),
});

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const authRoutes = new Hono<Env>();

async function startSession(c: Context<Env>, userId: string) {
  const { config } = c.get("services");
  const token = await createSessionToken(userId, config.authSecret, config.SESSION_TTL_HOURS);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction || new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}

authRoutes.post("/register", async (c) => {
  const { config, repo } = c.get("services");
  if (!config.REGISTRATION_ENABLED) throw forbidden("Registration is closed.");
  const body = await c.req.json().catch(() => ({}));
  const { email, password } = Credentials.parse(body);
  if (config.REGISTRATION_INVITE_CODE) {
    const code = typeof body.inviteCode === "string" ? body.inviteCode : "";
    if (!safeEqual(code, config.REGISTRATION_INVITE_CODE)) throw forbidden("Invalid invite code.");
  }
  await enforceRateLimit(repo, `register:${clientIp(c)}`, 5, 3600, "Too many sign-up attempts. Try again later.");
  if (await repo.findUserByEmail(email)) throw conflict("An account with this email already exists.");
  const user = await repo.createUser({ id: randomUUID(), email, passwordHash: await hashPassword(password) }).catch((e) => {
    if (e?.code === "23505") throw conflict("An account with this email already exists.");
    throw e;
  });
  await startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email } }, 201);
});

authRoutes.post("/login", async (c) => {
  const { config, repo } = c.get("services");
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) }).parse(body);
  const window = 15 * 60;
  await enforceRateLimit(repo, `login-ip:${clientIp(c)}`, config.LOGIN_ATTEMPTS_PER_15_MIN * 3, window, "Too many login attempts. Try again in 15 minutes.");
  await enforceRateLimit(repo, `login-email:${parsed.email}`, config.LOGIN_ATTEMPTS_PER_15_MIN, window, "Too many login attempts for this account. Try again in 15 minutes.");
  const user = await repo.findUserByEmail(parsed.email);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await verifyPassword(parsed.password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok) throw unauthorized("Incorrect email or password.");
  await startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email } });
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireUser, (c) => c.json({ user: c.get("user") }));

