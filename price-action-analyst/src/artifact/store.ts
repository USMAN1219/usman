/**
 * History for the instant-link edition, kept in this browser (IndexedDB),
 * screenshots included. Every call tolerates storage being unavailable.
 */
import type { ChartAnalysis } from "../../shared/analysis-schema.ts";
import { DEFAULT_SETTINGS, type DerivedAnalysis, type UserSettings } from "../../shared/types.ts";

export interface SavedAnalysis {
  id: string;
  createdAt: string;
  symbol: string | null;
  images: { blob: Blob; label: string | null; width: number; height: number }[];
  result: ChartAnalysis;
  derived: DerivedAnalysis;
  deep: boolean;
  example?: boolean;
}

const DB = "paa-instant";
const STORE = "analyses";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const saveAnalysis = (a: SavedAnalysis) => run("readwrite", (s) => s.put(a)).then((r) => r !== null);
export const deleteAnalysis = (id: string) => run("readwrite", (s) => s.delete(id));
export const listAnalyses = async (): Promise<SavedAnalysis[]> =>
  ((await run<SavedAnalysis[]>("readonly", (s) => s.getAll())) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const SETTINGS_KEY = "paa.instant.settings";
export interface InstantSettings extends UserSettings {
  pointValues: Record<string, number>;
}
export function loadSettings(): InstantSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, pointValues: {}, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS, pointValues: {} };
}
export function saveSettings(s: InstantSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
