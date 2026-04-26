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
 * The refresh itself is async (`computeFilterV2Data` yields between hot loops
 * via `await new Promise(r => setImmediate(r))`), so other endpoints stay
 * responsive while it runs. /health doesn't get blocked.
 */

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

async function doRefresh(
  db: Database.Database,
  _strategyManager: StrategyManager | null,
): Promise<HeavyData> {
  const start = Date.now();
  logger.info('Heavy cache refresh starting');
  const v2 = await computeFilterV2Data(db);
  const pricePathDetail = computePricePathData(db);
  const pricePathHtml = renderPricePathHtml(db);
  const result: HeavyData = {
    v2,
    pricePathDetail,
    pricePathHtml,
    computedAt: Date.now(),
  };
  cache = result;
  saveToDisk(db, result);
  logger.info({ elapsedMs: Date.now() - start }, 'Heavy cache refresh complete');
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
  // dedupe on the `refreshing` promise.
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
