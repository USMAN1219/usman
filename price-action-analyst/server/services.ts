/**
 * Service container: builds the configured repository, blob store and AI
 * analyzer once per process (i.e. once per warm serverless instance).
 */
import { ClaudeChartAnalyzer, type ChartAnalyzer } from "./ai/analyzer.ts";
import { MockChartAnalyzer } from "./ai/mock.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { MemoryRepository } from "./db/memory.ts";
import { createSql, PostgresRepository } from "./db/postgres.ts";
import type { Repository } from "./db/types.ts";
import { FsBlobStore, MemoryBlobStore, NetlifyBlobStore, type BlobStore } from "./storage/index.ts";
import { DEFAULT_SETTINGS, type UserSettings } from "../shared/types.ts";

export interface Services {
  config: AppConfig;
  repo: Repository;
  storage: BlobStore;
  analyzer: ChartAnalyzer;
}

let current: Services | null = null;

export function buildServices(config: AppConfig): Services {
  const repo: Repository = config.DB_DRIVER === "memory" ? new MemoryRepository() : new PostgresRepository(createSql(config.DATABASE_URL!));
  const storage: BlobStore =
    config.STORAGE_DRIVER === "memory"
      ? new MemoryBlobStore()
      : config.STORAGE_DRIVER === "fs"
        ? new FsBlobStore(config.FS_STORAGE_DIR)
        : new NetlifyBlobStore();
  const analyzer: ChartAnalyzer = config.AI_PROVIDER === "mock" ? new MockChartAnalyzer(1500) : new ClaudeChartAnalyzer(config);
  return { config, repo, storage, analyzer };
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
