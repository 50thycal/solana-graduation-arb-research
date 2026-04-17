/**
 * src/api/heavy-cache.ts
 *
 * Module-level cache for the handful of compute paths that take tens of
 * seconds on the current data volume:
 *   - computeFilterV2Data  (~100s @ 3k rows; feeds panels 1,2,4-10)
 *   - computePricePathData (feeds /api/price-path-detail + price-path-detail.json)
 *   - computeTradingData   (feeds /trading + trading.json)
 *   - renderPricePathHtml  (~40s; backs the /price-path HTML page)
 *
 * Why: before this cache, every /filter-analysis-v2 request AND every 2-min
 * gist-sync cycle triggered a fresh 100s compute. That blocked the Node event
 * loop long enough for Railway's 30s HTTP proxy to 502 most dashboard routes —
 * the user-visible "no pages load except /health" symptom.
 *
 * Contract: recompute on boot (first call), then at most once every TTL_MS.
 * The 2-min gist-sync still pushes all JSON files every cycle, but it re-uses
 * the cached heavy payloads instead of recomputing them.
 */

import type Database from 'better-sqlite3';
import { computeFilterV2Data, type FilterV2Data } from './filter-v2-data';
import { computePricePathData } from './price-path-data';
import { computeTradingData } from './trading-data';
import { renderPricePathHtml } from '../utils/html-renderer';
import type { StrategyManager } from '../trading/strategy-manager';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface HeavyData {
  v2: FilterV2Data;
  pricePathDetail: ReturnType<typeof computePricePathData>;
  tradingData: ReturnType<typeof computeTradingData>;
  pricePathHtml: string;
  computedAt: number;
}

let cache: HeavyData | null = null;

export function getHeavyData(
  db: Database.Database,
  strategyManager: StrategyManager | null,
): HeavyData {
  if (cache && Date.now() - cache.computedAt < TTL_MS) return cache;
  return refreshHeavyData(db, strategyManager);
}

export function refreshHeavyData(
  db: Database.Database,
  strategyManager: StrategyManager | null,
): HeavyData {
  const v2 = computeFilterV2Data(db);
  const pricePathDetail = computePricePathData(db);
  const tradingData = computeTradingData(db, strategyManager, {
    topPairs: v2.panel6.top_pairs,
  });
  const pricePathHtml = renderPricePathHtml(db);
  cache = {
    v2,
    pricePathDetail,
    tradingData,
    pricePathHtml,
    computedAt: Date.now(),
  };
  return cache;
}

export function getHeavyCacheInfo(): {
  cached: boolean;
  age_sec: number | null;
  ttl_sec: number;
} {
  return {
    cached: cache !== null,
    age_sec: cache ? Math.floor((Date.now() - cache.computedAt) / 1000) : null,
    ttl_sec: Math.floor(TTL_MS / 1000),
  };
}
