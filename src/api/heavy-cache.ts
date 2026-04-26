/**
 * src/api/heavy-cache.ts
 *
 * Module-level cache for the handful of compute paths that take tens of
 * seconds on the current data volume:
 *   - computeFilterV2Data  (~100s @ 4k rows; feeds panels 1,2,4-10 + v3 panels)
 *   - computePricePathData (feeds /api/price-path-detail + price-path-detail.json)
 *   - renderPricePathHtml  (~40s; backs the /price-path HTML page)
 *
 * Two layers of caching:
 *
 * 1. **In-memory** (`cache`) — TTL of 24h. Hot path returns immediately.
 *
 * 2. **SQLite** (`cache_kv` table) — survives process restarts. Without this,
 *    every Railway redeploy triggered another ~100s blocking recompute on the
 *    first request that hit /trading or /thesis. With it, redeploys load the
 *    last cached blob in ~50ms and serve from memory immediately.
 *
 * Stale-cache behavior: when the in-memory cache is past its TTL but a stale
 * value exists, we return the stale value immediately AND kick off a refresh
 * in the background via setImmediate(). This means a user request never blocks
 * on a recompute — the next request after the refresh completes gets the
 * fresh data.
 *
 * The refresh runs in a worker_threads Worker (heavy-cache-worker.ts) so the
 * main event loop keeps serving /health, /trading, gist-sync, and the WS
 * handler while the ~100s aggregation churns. The previous in-process design
 * yielded only between major phases; in production /health was queueing for
 * 35–50s behind it. Falls back to in-process compute if the worker fails to
 * spawn (dev / missing dist build).
 */

import path from 'path';
import { Worker } from 'worker_threads';
import type Database from 'better-sqlite3';
import { computeFilterV2Data, type FilterV2Data } from './filter-v2-data';
import { computePricePathData } from './price-path-data';
import { renderPricePathHtml } from '../utils/html-renderer';
import type { StrategyManager } from '../trading/strategy-manager';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('heavy-cache');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Bumped to v2 when we switched to the SQLite-backed layout; if the schema
// of FilterV2Data ever changes incompatibly, bump again to invalidate stale
// disk blobs without manual cleanup.
const CACHE_KEY = 'heavy_data_v2';

interface HeavyData {
  v2: FilterV2Data;
  pricePathDetail: ReturnType<typeof computePricePathData>;
  pricePathHtml: string;
  computedAt: number;
}

let cache: HeavyData | null = null;
// Single-flight: dedupes concurrent refreshes. While one is in flight, all
// callers wait on the same promise instead of stampeding 4 parallel ~100s computes.
let refreshing: Promise<HeavyData> | null = null;
let diskLoadAttempted = false;

function loadFromDisk(db: Database.Database): HeavyData | null {
  try {
    const row = db.prepare(
      'SELECT value_json, computed_at FROM cache_kv WHERE key = ?',
    ).get(CACHE_KEY) as { value_json: string; computed_at: number } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value_json) as Omit<HeavyData, 'computedAt'>;
    const ageSec = Math.floor((Date.now() - row.computed_at) / 1000);
    logger.info({ ageSec }, 'Loaded heavy cache from SQLite (skipping ~100s recompute)');
    return { ...parsed, computedAt: row.computed_at };
  } catch (err) {
    logger.warn({ err }, 'Failed to load heavy cache from SQLite — will recompute');
    return null;
  }
}

function saveToDisk(db: Database.Database, data: HeavyData): void {
  try {
    const json = JSON.stringify({
      v2: data.v2,
      pricePathDetail: data.pricePathDetail,
      pricePathHtml: data.pricePathHtml,
    });
    db.prepare(`
      INSERT INTO cache_kv (key, value_json, computed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        computed_at = excluded.computed_at
    `).run(CACHE_KEY, json, data.computedAt);
    logger.info({ sizeBytes: json.length }, 'Persisted heavy cache to SQLite');
  } catch (err) {
    // Persistence failure must never break the request. Worst case, the next
    // restart recomputes — same behavior as before this commit.
    logger.warn({ err }, 'Failed to persist heavy cache to SQLite — in-memory only');
  }
}

interface WorkerResult {
  ok: boolean;
  error?: string;
  stack?: string;
  v2?: FilterV2Data;
  pricePathDetail?: ReturnType<typeof computePricePathData>;
  pricePathHtml?: string;
}

function resolveDbPath(db: Database.Database): string {
  // better-sqlite3 exposes the filename as `.name` on the Database instance.
  // Fall back to `:memory:` only if undefined — that would be a misconfig
  // (we always init with a real path in db/schema.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filename = (db as any).name as string | undefined;
  if (!filename) throw new Error('Cannot resolve DB path from better-sqlite3 handle');
  return filename;
}

function resolveWorkerPath(): string | null {
  // After tsc, this file lives at dist/api/heavy-cache.js, so __dirname is
  // dist/api/. The worker compiles to dist/api/heavy-cache-worker.js.
  // Under ts-node (dev), __dirname is src/api/ and a .ts worker won't load
  // cleanly via new Worker() — return null so the caller falls back to
  // in-process compute.
  const here = __dirname;
  // path.sep is '/' on Linux/Railway and '\' on Windows. We only ship Node
  // builds via Railway today; this still works on dev macOS.
  const isCompiled = here.endsWith(`${path.sep}dist${path.sep}api`);
  if (!isCompiled) return null;
  return path.join(here, 'heavy-cache-worker.js');
}

function runInWorker(dbPath: string): Promise<Omit<HeavyData, 'computedAt'>> {
  const workerFile = resolveWorkerPath();
  if (!workerFile) {
    return Promise.reject(new Error('Worker file path unresolved (dev mode?)'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerFile, { workerData: { dbPath } });
    worker.once('message', (msg: WorkerResult) => {
      if (settled) return;
      settled = true;
      if (msg.ok && msg.v2 && msg.pricePathDetail !== undefined && msg.pricePathHtml !== undefined) {
        resolve({
          v2: msg.v2,
          pricePathDetail: msg.pricePathDetail,
          pricePathHtml: msg.pricePathHtml,
        });
      } else {
        reject(new Error(`Worker reported failure: ${msg.error || 'unknown'}`));
      }
      worker.terminate().catch(() => { /* ignore */ });
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Worker exited with code ${code} before posting result`));
    });
  });
}

async function doRefreshInProcess(db: Database.Database): Promise<Omit<HeavyData, 'computedAt'>> {
  const v2 = await computeFilterV2Data(db);
  const pricePathDetail = computePricePathData(db);
  const pricePathHtml = renderPricePathHtml(db);
  return { v2, pricePathDetail, pricePathHtml };
}

async function doRefresh(
  db: Database.Database,
  _strategyManager: StrategyManager | null,
): Promise<HeavyData> {
  const start = Date.now();
  logger.info('Heavy cache refresh starting');

  let payload: Omit<HeavyData, 'computedAt'>;
  let mode: 'worker' | 'in-process-fallback' = 'worker';
  try {
    const dbPath = resolveDbPath(db);
    payload = await runInWorker(dbPath);
  } catch (err) {
    mode = 'in-process-fallback';
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Heavy compute worker unavailable — falling back to in-process (will block event loop)',
    );
    payload = await doRefreshInProcess(db);
  }

  const result: HeavyData = { ...payload, computedAt: Date.now() };
  cache = result;
  saveToDisk(db, result);
  logger.info({ elapsedMs: Date.now() - start, mode }, 'Heavy cache refresh complete');
  return result;
}

function scheduleBackgroundRefresh(
  db: Database.Database,
  strategyManager: StrategyManager | null,
): void {
  if (refreshing) return; // already in flight
  refreshing = doRefresh(db, strategyManager).finally(() => {
    refreshing = null;
  });
  // Don't await — caller gets stale data immediately, fresh data lands later.
}

export async function getHeavyData(
  db: Database.Database,
  strategyManager: StrategyManager | null,
): Promise<HeavyData> {
  // Hot path: in-memory cache fresh.
  if (cache && Date.now() - cache.computedAt < TTL_MS) return cache;

  // First request after process boot: try SQLite before computing.
  if (!cache && !diskLoadAttempted) {
    diskLoadAttempted = true;
    cache = loadFromDisk(db);
  }

  if (cache) {
    // Have something — fresh or stale. If stale, kick off a background
    // refresh; either way return immediately.
    if (Date.now() - cache.computedAt >= TTL_MS) {
      scheduleBackgroundRefresh(db, strategyManager);
    }
    return cache;
  }

  // No cache, no disk — must compute now and await. Concurrent callers
  // dedupe on the `refreshing` promise. The compute itself runs off-thread
  // (worker), so other endpoints (incl. /health) stay responsive while we wait.
  if (!refreshing) {
    refreshing = doRefresh(db, strategyManager).finally(() => {
      refreshing = null;
    });
  }
  return await refreshing;
}

export async function refreshHeavyData(
  db: Database.Database,
  strategyManager: StrategyManager | null,
): Promise<HeavyData> {
  if (!refreshing) {
    refreshing = doRefresh(db, strategyManager).finally(() => {
      refreshing = null;
    });
  }
  return await refreshing;
}

export function getHeavyCacheInfo(): {
  cached: boolean;
  age_sec: number | null;
  ttl_sec: number;
  refreshing: boolean;
} {
  return {
    cached: cache !== null,
    age_sec: cache ? Math.floor((Date.now() - cache.computedAt) / 1000) : null,
    ttl_sec: Math.floor(TTL_MS / 1000),
    refreshing: refreshing !== null,
  };
}
