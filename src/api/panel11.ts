/**
 * src/api/panel11.ts
 *
 * Standalone computation for Panel 11 — Combo Filter Regime Stability.
 * Extracted so it can be called from:
 *   - /filter-analysis-v2 route handler (HTML render)
 *   - /api/panel11 JSON endpoint
 *   - gist-sync (panel11.json → bot-status branch for Claude self-serve)
 *
 * Returns the same structure that html-renderer.ts expects for panel11.
 */

import Database from 'better-sqlite3';
import { FILTER_CATALOG, computeBestCombos } from './aggregates';

const ROUND_TRIP_COST_PCT = 3.0;
const BUCKET_COUNT = 4;
const MIN_BUCKET_N = 5;
const ENTRY_GATE_MIN = 5;
const ENTRY_GATE_MAX = 100;

export type RegimeRow = {
  created_at: number;
  label: string;
  pct_t30: number;
  pct_t300: number;
  cost_pct: number;
  bc_velocity_sol_per_min: number | null;
  token_age_seconds: number | null;
  holder_count: number | null;
  top5_wallet_pct: number | null;
  dev_wallet_pct: number | null;
  total_sol_raised: number | null;
  liquidity_sol_t30: number | null;
  volatility_0_30: number | null;
  monotonicity_0_30: number | null;
  max_drawdown_0_30: number | null;
  dip_and_recover_flag: number | null;
  acceleration_t30: number | null;
  early_vs_late_0_30: number | null;
  buy_pressure_buy_ratio: number | null;
  buy_pressure_unique_buyers: number | null;
  buy_pressure_whale_pct: number | null;
  creator_prior_token_count: number | null;
  creator_prior_rug_rate: number | null;
  creator_prior_avg_return: number | null;
  creator_last_token_age_hours: number | null;
  max_relret_0_300: number | null;
};

// Entry gate predicate — mirrors /api/best-combos
export const ENTRY_GATE_PRED = (r: RegimeRow): boolean =>
  r.pct_t30 >= ENTRY_GATE_MIN && r.pct_t30 <= ENTRY_GATE_MAX;

// In-memory predicate for every FILTER_CATALOG entry — mirrors the SQL WHERE clause
export const CATALOG_PREDICATES = new Map<string, (r: RegimeRow) => boolean>([
  // Velocity
  ['vel < 5',    (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 5],
  ['vel 5-10',   (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5  && r.bc_velocity_sol_per_min < 10],
  ['vel 5-20',   (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5  && r.bc_velocity_sol_per_min < 20],
  ['vel 10-20',  (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 10 && r.bc_velocity_sol_per_min < 20],
  ['vel < 20',   (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20],
  ['vel < 50',   (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 50],
  ['vel 20-50',  (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 20 && r.bc_velocity_sol_per_min < 50],
  ['vel 50-200', (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 50 && r.bc_velocity_sol_per_min < 200],
  // BC Age
  ['age < 10min', (r) => r.token_age_seconds != null && r.token_age_seconds < 600],
  ['age > 10min', (r) => r.token_age_seconds != null && r.token_age_seconds > 600],
  ['age > 30min', (r) => r.token_age_seconds != null && r.token_age_seconds > 1800],
  ['age > 1hr',   (r) => r.token_age_seconds != null && r.token_age_seconds > 3600],
  // Holders
  ['holders >= 5',  (r) => r.holder_count != null && r.holder_count >= 5],
  ['holders >= 10', (r) => r.holder_count != null && r.holder_count >= 10],
  ['holders >= 15', (r) => r.holder_count != null && r.holder_count >= 15],
  ['holders >= 18', (r) => r.holder_count != null && r.holder_count >= 18],
  // Top 5 Concentration
  ['top5 < 10%', (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 10],
  ['top5 < 15%', (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 15],
  ['top5 < 20%', (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 20],
  // Dev Wallet
  ['dev < 3%', (r) => r.dev_wallet_pct != null && r.dev_wallet_pct < 3],
  ['dev < 5%', (r) => r.dev_wallet_pct != null && r.dev_wallet_pct < 5],
  // Liquidity
  ['liq > 50',  (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 50],
  ['liq > 100', (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 100],
  ['liq > 150', (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 150],
  // Path shape
  ['mono > 0.5',  (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.5],
  ['mono > 0.66', (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.66],
  ['dd > -10%',   (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -10],
  ['dd > -20%',   (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -20],
  ['accel > 0',   (r) => r.acceleration_t30 != null && r.acceleration_t30 > 0],
  // Buy pressure
  ['buy_ratio > 0.5', (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.5],
  ['buy_ratio > 0.6', (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.6],
  ['buyers >= 5',     (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 5],
  ['buyers >= 10',    (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 10],
  ['whale < 30%',     (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 30],
  ['whale < 50%',     (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 50],
  // Creator reputation
  ['fresh_dev',       (r) => r.creator_prior_token_count != null && r.creator_prior_token_count === 0],
  ['repeat_dev >= 3', (r) => r.creator_prior_token_count != null && r.creator_prior_token_count >= 3],
  ['clean_dev',       (r) => r.creator_prior_rug_rate != null && r.creator_prior_rug_rate < 0.3],
  ['serial_rugger',   (r) => r.creator_prior_rug_rate != null && r.creator_prior_rug_rate >= 0.7],
  ['rapid_fire',      (r) => r.creator_last_token_age_hours != null && r.creator_last_token_age_hours < 1],
  // Peak return from entry
  ['peak > 20%',  (r) => r.max_relret_0_300 != null && r.max_relret_0_300 > 20],
  ['peak > 40%',  (r) => r.max_relret_0_300 != null && r.max_relret_0_300 > 40],
  ['peak > 75%',  (r) => r.max_relret_0_300 != null && r.max_relret_0_300 > 75],
  ['peak > 100%', (r) => r.max_relret_0_300 != null && r.max_relret_0_300 > 100],
]);

export function loadRegimeRows(db: Database.Database): RegimeRow[] {
  return db.prepare(`
    SELECT created_at, label, pct_t30, pct_t300,
           COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct,
           bc_velocity_sol_per_min, token_age_seconds, holder_count, top5_wallet_pct,
           dev_wallet_pct, total_sol_raised, liquidity_sol_t30, volatility_0_30,
           monotonicity_0_30, max_drawdown_0_30, dip_and_recover_flag, acceleration_t30,
           early_vs_late_0_30, buy_pressure_buy_ratio, buy_pressure_unique_buyers,
           buy_pressure_whale_pct,
           creator_prior_token_count, creator_prior_rug_rate, creator_prior_avg_return,
           creator_last_token_age_hours,
           max_relret_0_300
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND pct_t30 IS NOT NULL
      AND pct_t300 IS NOT NULL
      AND created_at IS NOT NULL
    ORDER BY created_at ASC
  `).all() as RegimeRow[];
}

export function computeBucketBoundaries(rows: RegimeRow[]): { start: number; end: number }[] {
  if (rows.length === 0) return [];
  const bucketSize = Math.ceil(rows.length / BUCKET_COUNT);
  const boundaries: { start: number; end: number }[] = [];
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const startIdx = i * bucketSize;
    const endIdx = Math.min((i + 1) * bucketSize, rows.length);
    if (startIdx >= rows.length) break;
    boundaries.push({ start: rows[startIdx].created_at, end: rows[endIdx - 1].created_at });
  }
  return boundaries;
}

export function runFilterRegime(
  predicate: (r: RegimeRow) => boolean,
  rows: RegimeRow[],
  boundaries: { start: number; end: number }[],
) {
  const buckets: { n: number; pump: number; returns: number[] }[] =
    Array.from({ length: boundaries.length }, () => ({ n: 0, pump: 0, returns: [] }));

  for (const r of rows) {
    if (!predicate(r)) continue;
    let bucketIdx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      if (r.created_at <= boundaries[i].end) { bucketIdx = i; break; }
    }
    if (bucketIdx === -1) bucketIdx = boundaries.length - 1;
    if (bucketIdx < 0) continue;
    const b = buckets[bucketIdx];
    b.n++;
    if (r.label === 'PUMP') b.pump++;
    const ret = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100 - r.cost_pct;
    b.returns.push(ret);
  }

  const perBucket = buckets.map(b => {
    if (b.n < MIN_BUCKET_N) return { n: b.n, win_rate_pct: null as number | null, avg_return_pct: null as number | null };
    const wr = +(b.pump / b.n * 100).toFixed(1);
    const avgRet = +(b.returns.reduce((s, v) => s + v, 0) / b.returns.length).toFixed(1);
    return { n: b.n, win_rate_pct: wr, avg_return_pct: avgRet };
  });

  const validWRs = perBucket.filter(b => b.win_rate_pct != null).map(b => b.win_rate_pct as number);
  let wrStdDev: number | null = null;
  let stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT' = 'INSUFFICIENT';
  if (validWRs.length >= 2) {
    const mean = validWRs.reduce((a, b) => a + b, 0) / validWRs.length;
    wrStdDev = +Math.sqrt(validWRs.reduce((s, w) => s + (w - mean) ** 2, 0) / validWRs.length).toFixed(1);
    stability = wrStdDev < 8 ? 'STABLE' : wrStdDev < 15 ? 'MODERATE' : 'CLUSTERED';
  }

  return {
    n: buckets.reduce((s, b) => s + b.n, 0),
    buckets: perBucket,
    wr_std_dev: wrStdDev,
    stability,
  };
}

export interface Panel11Data {
  generated_at: string;
  title: string;
  description: string;
  bucket_windows: { bucket: number; start_iso: string; end_iso: string }[];
  baseline: {
    filter: string;
    group: string;
    sim_avg_return: number | null;
    beats_baseline: boolean;
    n: number;
    buckets: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }[];
    wr_std_dev: number | null;
    stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
  };
  filters: Array<{
    filter: string;
    group: string;
    sim_avg_return: number | null;
    beats_baseline: boolean;
    n: number;
    buckets: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }[];
    wr_std_dev: number | null;
    stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
  }>;
  flags: { low_n_threshold: number; strong_n_threshold: number };
}

export function computePanel11(db: Database.Database): Panel11Data {
  const rows = loadRegimeRows(db);
  const boundaries = computeBucketBoundaries(rows);

  const baseline = {
    filter: 'ALL labeled (entry gate only)',
    group: 'Baseline',
    sim_avg_return: null as number | null,
    beats_baseline: false,
    ...runFilterRegime(ENTRY_GATE_PRED, rows, boundaries),
  };

  const bestCombos = computeBestCombos(db, { min_n: 20, top: 40, include_pairs: true });

  const filters = bestCombos.rows
    .filter(row => row.filters.length === 2)
    .map(row => {
      const predA = CATALOG_PREDICATES.get(row.filters[0]);
      const predB = CATALOG_PREDICATES.get(row.filters[1]);
      if (!predA || !predB) return null;
      const comboPred = (r: RegimeRow) => ENTRY_GATE_PRED(r) && predA(r) && predB(r);
      const regime = runFilterRegime(comboPred, rows, boundaries);
      return {
        filter: row.filter_spec,
        group: `${FILTER_CATALOG.find(f => f.name === row.filters[0])?.group ?? ''} × ${FILTER_CATALOG.find(f => f.name === row.filters[1])?.group ?? ''}`,
        sim_avg_return: row.sim_avg_return_10sl_50tp_pct,
        beats_baseline: row.beats_baseline,
        ...regime,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const bucket_windows = boundaries.map((b, i) => ({
    bucket: i + 1,
    start_iso: new Date(b.start * 1000).toISOString(),
    end_iso: new Date(b.end * 1000).toISOString(),
  }));

  return {
    generated_at: new Date().toISOString(),
    title: 'Combo Filter Regime Stability — Cross-Group Filter Pairs',
    description:
      'Regime check for every cross-group two-filter combination in the catalog, with the T+30 entry gate (+5% to +100%) applied. Rows are the EXACT same combos as /api/best-combos, ordered by sim return descending. Use this to validate that a high-sim-return combo also holds up across time buckets.',
    bucket_windows,
    baseline,
    filters,
    flags: { low_n_threshold: 20, strong_n_threshold: 100 },
  };
}
