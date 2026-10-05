/**
 * Service container: builds the configured repository, blob store and AI
 * analyzer once per process (i.e. once per warm serverless instance).
 */
import { ClaudeChartAnalyzer, type ChartAnalyzer } from "./ai/analyzer.ts";
import { GeminiChartAnalyzer } from "./ai/gemini.ts";
import { MockChartAnalyzer } from "./ai/mock.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { MemoryRepository } from "./db/memory.ts";
import { createSql, PostgresRepository } from "./db/postgres.ts";
import { migrate } from "./db/schema.ts";
import { AppError } from "./errors.ts";
import { log } from "./logger.ts";
import type { Repository } from "./db/types.ts";
import { FsBlobStore, MemoryBlobStore, NetlifyBlobStore, type BlobStore } from "./storage/index.ts";
import { DEFAULT_SETTINGS, type UserSettings } from "../shared/types.ts";

export interface Services {
  config: AppConfig;
  repo: Repository;
  storage: BlobStore;
  analyzer: ChartAnalyzer;
  /** Resolves once the database schema exists (auto-migration). Await before using `repo`. */
  ready(): Promise<void>;
}

let current: Services | null = null;

export function buildServices(config: AppConfig): Services {
  let repo: Repository;
  let ready: () => Promise<void> = async () => {};
  if (config.DB_DRIVER === "memory") repo = new MemoryRepository();
  else {
    const sql = createSql(config.DATABASE_URL!);
    repo = new PostgresRepository(sql);
    if (config.AUTO_MIGRATE) {
      let pending: Promise<void> | null = null;
      // Create tables on first use, so deployment needs no manual database step. Retried if it fails.
      ready = () =>
        (pending ??= migrate(sql).catch((err) => {
          pending = null;
          log.error("db.migration_failed", { error: err instanceof Error ? err.message : String(err) });
          throw new AppError(503, "database_unavailable", "The database is not reachable. Check DATABASE_URL and try again.");
        }));
    }
  }
  const storage: BlobStore =
    config.STORAGE_DRIVER === "memory"
      ? new MemoryBlobStore()
      : config.STORAGE_DRIVER === "fs"
        ? new FsBlobStore(config.FS_STORAGE_DIR)
        : new NetlifyBlobStore();
  const analyzer: ChartAnalyzer =
    config.AI_PROVIDER === "mock"
      ? new MockChartAnalyzer(1500)
      : config.AI_PROVIDER === "gemini"
        ? new GeminiChartAnalyzer(config)
        : new ClaudeChartAnalyzer(config);
  return { config, repo, storage, analyzer, ready };
}

export function getServices(): Services {
  current ??= buildServices(loadConfig());
  return current;
}

/** Test hook. */
export function setServices(s: Services | null) {
  current = s;
}

export async function getUserSettings(repo: Repository, userId: string): Promise<UserSettings> {
  const stored = await repo.getSettings(userId);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(stored?.alerts ?? {}) },
  };
}
