/**
 * Sliding-window rate limiting backed by the database, so limits hold across
 * serverless instances (an in-memory counter would reset per cold start).
 */
import type { Repository } from "./db/types.ts";
import { rateLimited } from "./errors.ts";

export async function enforceRateLimit(
  repo: Repository,
  key: string,
  limit: number,
  windowSeconds: number,
  message: string,
): Promise<void> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const count = await repo.countRateEvents(key, since);
  if (count >= limit) throw rateLimited(message, windowSeconds);
  await repo.recordRateEvent(key);
}
