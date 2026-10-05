/**
 * The analysis job: load screenshots -> call the vision model -> apply
 * guardrails -> persist -> raise alerts. Runs either inside a Netlify
 * Background Function (up to 15 minutes) or inline for local development.
 */
import { randomUUID } from "node:crypto";
import { AnalysisError, type AnalyzerImage } from "../ai/analyzer.ts";
import { log } from "../logger.ts";
import { normalizeSymbol } from "../../shared/types.ts";
import { getUserSettings, type Services } from "../services.ts";
import { evaluateAlerts } from "./alerts.ts";
import { applyGuardrails } from "./guardrails.ts";

/** Jobs not finished after this long are reported as failed (background functions stop at 15 min). */
export const JOB_STALE_AFTER_MS = 16 * 60 * 1000;

export async function runAnalysisJob(services: Services, analysisId: string): Promise<void> {
  const { repo, storage, analyzer } = services;
  const claimed = await repo.claimAnalysis(analysisId);
  if (!claimed) {
    log.warn("analysis.job_not_claimed", { analysisId });
    return;
  }
  const record = await repo.getAnalysisForJob(analysisId);
  if (!record) return;

  try {
    const settings = await getUserSettings(repo, record.userId);
    const images: AnalyzerImage[] = [];
    for (const img of record.images) {
      const data = await storage.get(img.key);
      if (!data) throw new AnalysisError("An uploaded screenshot could not be loaded from storage. Please upload it again.", false);
      images.push({ data, mime: img.mime as AnalyzerImage["mime"], label: img.label, width: img.width, height: img.height });
    }

    const { analysis, usage } = await analyzer.analyze({
      images,
      symbolHint: record.symbolHint,
      notes: record.notes,
      minRr: settings.minRr,
    });

    const symbol = normalizeSymbol(record.symbolHint) ?? normalizeSymbol(analysis.symbol);
    const watch = symbol ? await repo.findWatchlistBySymbol(record.userId, symbol) : null;
    const derived = applyGuardrails({ analysis, settings, pointValue: watch?.pointValue ?? null });
    const previous = symbol ? await repo.latestCompletedForSymbol(record.userId, symbol, record.id) : null;

    const timeframes = analysis.timeframes.length ? analysis.timeframes : record.timeframes;
    await repo.completeAnalysis(record.id, { result: analysis, derived, symbol, timeframes, usage });

    const alerts = evaluateAlerts({ prefs: settings.alerts, symbol, analysis, derived, previous });
    for (const a of alerts) {
      await repo.addNotification({ id: randomUUID(), userId: record.userId, analysisId: record.id, ...a });
    }
    log.info("analysis.completed", { analysisId, decision: derived.finalDecision, grade: derived.grade, costUsd: usage.costUsd });
  } catch (err) {
    const message =
      err instanceof AnalysisError ? err.message : "The analysis failed unexpectedly. Please try again.";
    if (!(err instanceof AnalysisError)) log.error("analysis.job_failed", { analysisId, error: err instanceof Error ? err.stack : String(err) });
    await repo.setAnalysisStatus(analysisId, "failed", message);
  }
}
