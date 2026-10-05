import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { runAnalysisJob, JOB_STALE_AFTER_MS } from "../../analysis/job.ts";
import { inputHash, validateImages } from "../../analysis/images.ts";
import { AppError, badRequest, notFound, rateLimited } from "../../errors.ts";
import { log } from "../../logger.ts";
import type { Services } from "../../services.ts";
import { normalizeSymbol, type AnalysisRecord, type StoredImage } from "../../../shared/types.ts";
import { requireUser, type Env } from "../middleware.ts";

export const analysisRoutes = new Hono<Env>();
analysisRoutes.use("*", requireUser);

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

/** Starts the job: in a Netlify Background Function in production, or inline in local dev/tests. */
export async function dispatchAnalysis(services: Services, origin: string, id: string): Promise<void> {
  if (services.config.ANALYSIS_EXECUTION === "inline") {
    await runAnalysisJob(services, id);
    return;
  }
  if (services.config.ANALYSIS_EXECUTION === "async") {
    void runAnalysisJob(services, id).catch((err) => log.error("analysis.async_job_crashed", { id, error: String(err) }));
    return;
  }
  try {
    const res = await fetch(`${origin}/.netlify/functions/analyze-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-job-secret": services.config.INTERNAL_JOB_SECRET! },
      body: JSON.stringify({ id }),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`background dispatch returned ${res.status}`);
  } catch (err) {
    log.error("analysis.dispatch_failed", { id, error: err instanceof Error ? err.message : String(err) });
    await services.repo.setAnalysisStatus(id, "failed", "Could not start the analysis job. Please try again.");
  }
}

export function verifyJobSecret(services: Services, provided: string | null): boolean {
  const expected = services.config.INTERNAL_JOB_SECRET ?? "";
  if (!provided || expected.length < 32) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Marks jobs that never finished (e.g. a crashed worker) as failed so the UI stops waiting. */
async function expireIfStale(services: Services, a: AnalysisRecord): Promise<AnalysisRecord> {
  if ((a.status === "queued" || a.status === "processing") && Date.now() - Date.parse(a.createdAt) > JOB_STALE_AFTER_MS) {
    await services.repo.setAnalysisStatus(a.id, "failed", "The analysis timed out. Please try again.");
    return { ...a, status: "failed", error: "The analysis timed out. Please try again." };
  }
  return a;
}

async function enforceAnalysisLimits(services: Services, userId: string) {
  const { repo, config } = services;
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  if ((await repo.countAnalysesSince(userId, hourAgo)) >= config.RATE_LIMIT_ANALYSES_PER_HOUR)
    throw rateLimited(`Hourly limit of ${config.RATE_LIMIT_ANALYSES_PER_HOUR} analyses reached. Please wait before analysing again.`, 600);
  if ((await repo.countAnalysesSince(userId, dayAgo)) >= config.RATE_LIMIT_ANALYSES_PER_DAY)
    throw rateLimited(`Daily limit of ${config.RATE_LIMIT_ANALYSES_PER_DAY} analyses reached.`, 3600);
  if (config.MONTHLY_BUDGET_USD != null && config.MONTHLY_BUDGET_USD > 0) {
    const usage = await repo.usageSince(null, monthStart());
    if (usage.costUsd >= config.MONTHLY_BUDGET_USD)
      throw new AppError(503, "budget_exhausted", "The monthly AI budget for this app has been reached. Analyses resume next month or when the operator raises MONTHLY_BUDGET_USD.");
  }
}

const textField = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > max) throw badRequest(`Text field is longer than ${max} characters.`);
  return t || null;
};

analysisRoutes.post("/", async (c) => {
  const services = c.get("services");
  const { repo, storage, config } = services;
  const user = c.get("user");

  const body = await c.req.parseBody({ all: true });
  const rawFiles = ([] as unknown[]).concat(body["images"] ?? []);
  const files: File[] = rawFiles.filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  let labels: (string | null)[] = [];
  if (typeof body["labels"] === "string") {
    try {
      labels = z.array(z.string().max(24).nullable()).max(50).parse(JSON.parse(body["labels"]));
    } catch {
      throw badRequest("Invalid timeframe labels.");
    }
  }
  const symbolHint = normalizeSymbol(textField(body["symbol"], 40));
  const notes = textField(body["notes"], 1000);
  const force = body["force"] === "true";

  const images = validateImages(
    await Promise.all(files.map(async (f, i) => ({ data: new Uint8Array(await f.arrayBuffer()), label: labels[i] ?? null }))),
    config,
  );
  const hash = inputHash(images, symbolHint, notes);

  // Duplicate detection: identical screenshots + inputs return the earlier analysis instead of paying again.
  if (!force) {
    const since = new Date(Date.now() - config.DUPLICATE_WINDOW_HOURS * 3600_000).toISOString();
    const dup = await repo.findRecentByHash(user.id, hash, since);
    if (dup) return c.json({ duplicate: true, analysis: dup }, 200);
  }

  await enforceAnalysisLimits(services, user.id);

  const id = randomUUID();
  const stored: StoredImage[] = [];
  for (const [i, img] of images.entries()) {
    const key = `${user.id}/${id}/${i}.${EXT[img.mime]}`;
    await storage.put(key, img.data, img.mime);
    stored.push({ key, label: img.label, mime: img.mime, bytes: img.bytes, width: img.width, height: img.height, sha256: img.sha256 });
  }
  const timeframes = stored.map((s) => s.label).filter((l): l is string => !!l);
  await repo.createAnalysis({ id, userId: user.id, symbolHint, timeframes, images: stored, notes, inputHash: hash });
  await dispatchAnalysis(services, new URL(c.req.url).origin, id);

  const record = await repo.getAnalysis(user.id, id);
  return c.json({ duplicate: false, analysis: record }, 202);
});

const ListQuery = z.object({
  symbol: z.string().max(40).optional().transform((v) => normalizeSymbol(v) ?? undefined),
  direction: z.enum(["long", "short", "no_trade"]).optional(),
  grade: z.enum(["A+", "A", "B", "C", "no_trade"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

analysisRoutes.get("/", async (c) => {
  const q = ListQuery.parse(c.req.query());
  return c.json(await c.get("services").repo.listAnalyses(c.get("user").id, q));
});

async function load(c: Context<Env>): Promise<AnalysisRecord> {
  const services = c.get("services");
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw notFound("Analysis not found.");
  const a = await services.repo.getAnalysis(c.get("user").id, id);
  if (!a) throw notFound("Analysis not found.");
  return expireIfStale(services, a);
}

analysisRoutes.get("/:id", async (c) => c.json({ analysis: await load(c) }));

analysisRoutes.get("/:id/images/:index", async (c) => {
  const a = await load(c);
  const img = a.images[Number(c.req.param("index"))];
  if (!img) throw notFound("Image not found.");
  const data = await c.get("services").storage.get(img.key);
  if (!data) throw notFound("Image not found.");
  return c.body(data as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": img.mime,
    "Cache-Control": "private, max-age=86400, immutable",
  });
});

analysisRoutes.delete("/:id", async (c) => {
  const services = c.get("services");
  const a = await load(c);
  await services.repo.deleteAnalysis(a.userId, a.id);
  await Promise.all(a.images.map((img) => services.storage.delete(img.key).catch(() => undefined)));
  return c.json({ ok: true });
});

/** Retry a failed analysis as a fresh job (copies the screenshots, removes the failed record). */
analysisRoutes.post("/:id/retry", async (c) => {
  const services = c.get("services");
  const { repo, storage } = services;
  const a = await load(c);
  if (a.status !== "failed") throw badRequest("Only failed analyses can be retried.");
  await enforceAnalysisLimits(services, a.userId);
  const id = randomUUID();
  const images: StoredImage[] = [];
  for (const [i, img] of a.images.entries()) {
    const data = await storage.get(img.key);
    if (!data) throw badRequest("The original screenshots are no longer available. Please upload them again.");
    const key = `${a.userId}/${id}/${i}.${EXT[img.mime]}`;
    await storage.put(key, data, img.mime);
    images.push({ ...img, key });
  }
  await repo.createAnalysis({ id, userId: a.userId, symbolHint: a.symbolHint, timeframes: a.timeframes, images, notes: a.notes, inputHash: a.inputHash });
  await repo.deleteAnalysis(a.userId, a.id);
  await Promise.all(a.images.map((img) => storage.delete(img.key).catch(() => undefined)));
  await dispatchAnalysis(services, new URL(c.req.url).origin, id);
  return c.json({ analysis: await repo.getAnalysis(a.userId, id) }, 202);
});

const Outcome = z.object({
  taken: z.boolean(),
  outcomePnl: z.number().finite().nullable().default(null),
  outcomeNote: z.string().trim().max(500).nullable().default(null),
});

analysisRoutes.patch("/:id/outcome", async (c) => {
  const a = await load(c);
  const o = Outcome.parse(await c.req.json());
  const updated = await c.get("services").repo.setOutcome(a.userId, a.id, o);
  return c.json({ analysis: updated });
});
