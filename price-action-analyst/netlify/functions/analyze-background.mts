/**
 * Netlify Background Function (runs up to 15 minutes; the caller gets 202 immediately).
 * Executes one chart-analysis job. Only callable with INTERNAL_JOB_SECRET, because
 * background functions are reachable at a public URL.
 */
import { runAnalysisJob } from "../../server/analysis/job.ts";
import { verifyJobSecret } from "../../server/http/routes/analyses.ts";
import { log } from "../../server/logger.ts";
import { getServices } from "../../server/services.ts";

export default async (req: Request) => {
  const services = getServices();
  if (req.method !== "POST" || !verifyJobSecret(services, req.headers.get("x-internal-job-secret"))) {
    log.warn("background.rejected", { method: req.method });
    return;
  }
  let id: unknown;
  try {
    id = ((await req.json()) as { id?: unknown }).id;
  } catch {
    return;
  }
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  await runAnalysisJob(services, id);
};
