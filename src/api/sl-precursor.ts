import type Database from 'better-sqlite3';
import { bucketByDow, bucketByHour, DOW_LABELS } from './trends-time';

/**
 * SL / exit pattern mining panel. For each strategy with >= MIN_TRADES_PER_STRATEGY
 * closed trades, computes:
 *
 *  1. Time-to-SL distribution — bucket held_seconds for SL exits into 5 windows.
 *  2. Precursor signature — Cohen's d between SL and TP cohorts on a fixed set
 *     of T+30-known features (entry-time features, no look-ahead).
 *  3. SL clustering — bucket trades into 30-min windows, compare observed
 *     variance of windowed SL rates to Poisson expectation. Variance ratio
 *     > 1 implies temporal clustering (regime memory).
 *  4. Near-miss recoveries — winning trades whose intra-position low (sampled
 *     from graduation_momentum checkpoints inside [entry, exit]) drew within
 *     NEAR_MISS_PCT_OF_SL of the configured SL price.
 *  5. Exit-reason mix by calendar bucket — distribution of exit_reason across
 *     UTC day-of-week and hour-of-day buckets.
 *
 * All features used in (2) are known at or before T+30 — see the look-ahead
 * leak rule in CLAUDE.md.
 */

const MIN_TRADES_PER_STRATEGY = 50;
const PRECURSOR_MIN_COHORT = 10;
const PRECURSOR_D_THRESHOLD = 0.3;
const CLUSTER_WINDOW_SEC = 30 * 60;          // 30-min bins
const CLUSTER_MIN_TRADES_PER_WINDOW = 3;
const NEAR_MISS_PCT_OF_SL = 1.0;             // intra-low within 1.0% of SL price

// Features for the precursor signature. All known at or before T+30 — safe for
// entry-time prediction. See CLAUDE.md look-ahead leak rule.
const PRECURSOR_FEATURES = [
  'bc_velocity_sol_per_min',
  'top5_wallet_pct',
  'holder_count',
  'max_drawdown_0_30',
  'monotonicity_0_30',
  'buy_pressure_buy_ratio',
  'sniper_count_t0_t2',
  'acceleration_t30',
] as const;
type PrecursorFeature = typeof PRECURSOR_FEATURES[number];

// Price checkpoint columns + their T+offset (seconds since graduation).
const CHECKPOINTS: Array<{ col: string; sec: number }> = [
  { col: 'price_t5', sec: 5 }, { col: 'price_t10', sec: 10 },
  { col: 'price_t15', sec: 15 }, { col: 'price_t20', sec: 20 },
  { col: 'price_t25', sec: 25 }, { col: 'price_t30', sec: 30 },
  { col: 'price_t35', sec: 35 }, { col: 'price_t40', sec: 40 },
  { col: 'price_t45', sec: 45 }, { col: 'price_t50', sec: 50 },
  { col: 'price_t55', sec: 55 }, { col: 'price_t60', sec: 60 },
  { col: 'price_t90', sec: 90 }, { col: 'price_t120', sec: 120 },
  { col: 'price_t150', sec: 150 }, { col: 'price_t180', sec: 180 },
  { col: 'price_t240', sec: 240 }, { col: 'price_t300', sec: 300 },
  { col: 'price_t600', sec: 600 },
];

export type ClusteringFlag = 'clustered' | 'independent' | 'under-dispersed' | 'insufficient-windows';

export interface TimeToSlBucket {
  range_label: string;
  min_sec: number;
  max_sec: number;
  n: number;
  share_of_sls_pct: number;
  mean_net_pct: number | null;
}

export interface PrecursorFeatureRow {
  feature: PrecursorFeature;
  sl_n: number;
  tp_n: number;
  sl_mean: number | null;
  tp_mean: number | null;
  cohens_d: number | null;
  /** True when |d| > PRECURSOR_D_THRESHOLD and both cohorts have enough samples. */
  notable: boolean;
}

export interface ClusteringResult {
  windows_used: number;
  windows_skipped_low_n: number;
  mean_window_n: number;
  pooled_sl_rate: number | null;
  observed_variance: number | null;
  poisson_expected_variance: number | null;
  variance_ratio: number | null;
  flag: ClusteringFlag;
}

export interface NearMissRow {
  trade_id: number;
  mint: string;
  graduation_id: number;
  entry_price_sol: number;
  intra_low_price_sol: number;
  intra_low_at_t_sec: number;
  sl_price_sol: number;
  pct_above_sl: number;          // (intra_low - sl_price) / sl_price * 100
  net_return_pct: number;
  exit_reason: string;
}

export interface ExitMixCell {
  bucket: string;
  n: number;
  take_profit: number;
  stop_loss: number;
  trailing_stop: number;
  trailing_tp: number;
  breakeven_stop: number;
  timeout: number;
  other: number;
}

export interface StrategySlPrecursor {
  strategy_id: string;
  label: string;
  n_closed: number;
  n_sl: number;
  sl_rate_pct: number;
  time_to_sl: TimeToSlBucket[];
  precursors: PrecursorFeatureRow[];
  /** Top features sorted by |cohens_d| desc, filtered to notable rows. */
  top_precursors: PrecursorFeatureRow[];
  clustering: ClusteringResult;
  near_miss: {
    n_winners_checked: number;
    n_near_miss: number;
    threshold_pct: number;
    rows: NearMissRow[];
  };
  exit_mix_by_dow: ExitMixCell[];
  exit_mix_by_hour: ExitMixCell[];
}

export interface SlPrecursorData {
  generated_at: string;
  config: {
    min_trades_per_strategy: number;
    precursor_min_cohort: number;
    precursor_d_threshold: number;
    cluster_window_sec: number;
    cluster_min_trades_per_window: number;
    near_miss_pct_of_sl: number;
  };
  strategies: StrategySlPrecursor[];
  notes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return v;
}

/** Cohen's d on raw samples. Returns null if either cohort is degenerate. */
function cohensD(slXs: number[], tpXs: number[]): number | null {
  if (slXs.length < 2 || tpXs.length < 2) return null;
  const sm = mean(slXs)!;
  const tm = mean(tpXs)!;
  const sv = variance(slXs)!;
  const tv = variance(tpXs)!;
  const pooled = Math.sqrt(((slXs.length - 1) * sv + (tpXs.length - 1) * tv) / (slXs.length + tpXs.length - 2));
  if (pooled < 1e-9) return null;
  return (sm - tm) / pooled;
}

// ── Sub-analyses ──────────────────────────────────────────────────────────

interface TradeRow {
  id: number;
  strategy_id: string;
  graduation_id: number;
  mint: string;
  entry_timestamp: number;
  exit_timestamp: number;
  entry_price_sol: number;
  stop_loss_pct: number | null;
  net_profit_sol: number;
  net_return_pct: number;
  exit_reason: string;
  held_seconds: number;
}

function timeToSlBuckets(slTrades: TradeRow[], totalSls: number): TimeToSlBucket[] {
  const ranges: Array<{ label: string; min: number; max: number }> = [
    { label: '<30s', min: 0, max: 30 },
    { label: '30-60s', min: 30, max: 60 },
    { label: '60-120s', min: 60, max: 120 },
    { label: '120-240s', min: 120, max: 240 },
    { label: '240-300s', min: 240, max: 300 },
    { label: '>=300s', min: 300, max: Number.POSITIVE_INFINITY },
  ];
  return ranges.map(r => {
    const inBucket = slTrades.filter(t => t.held_seconds >= r.min && t.held_seconds < r.max);
    const m = mean(inBucket.map(t => t.net_return_pct));
    return {
      range_label: r.label,
      min_sec: r.min,
      max_sec: Number.isFinite(r.max) ? r.max : -1,
      n: inBucket.length,
      share_of_sls_pct: totalSls === 0 ? 0 : +((inBucket.length / totalSls) * 100).toFixed(2),
      mean_net_pct: m == null ? null : +m.toFixed(2),
    };
  });
}

function clusteringTest(allTrades: TradeRow[]): ClusteringResult {
  const buckets = new Map<number, { sl: number; total: number }>();
  for (const t of allTrades) {
    const bin = Math.floor(t.entry_timestamp / CLUSTER_WINDOW_SEC);
    const cur = buckets.get(bin) ?? { sl: 0, total: 0 };
    cur.total += 1;
    if (t.exit_reason === 'stop_loss') cur.sl += 1;
    buckets.set(bin, cur);
  }
  const qualifying = Array.from(buckets.values()).filter(b => b.total >= CLUSTER_MIN_TRADES_PER_WINDOW);
  const skipped = buckets.size - qualifying.length;
  if (qualifying.length < 2) {
    return {
      windows_used: qualifying.length,
      windows_skipped_low_n: skipped,
      mean_window_n: qualifying.length === 0 ? 0 : qualifying[0]?.total ?? 0,
      pooled_sl_rate: null,
      observed_variance: null,
      poisson_expected_variance: null,
      variance_ratio: null,
      flag: 'insufficient-windows',
    };
  }
  const rates = qualifying.map(b => b.sl / b.total);
  const meanN = qualifying.reduce((s, b) => s + b.total, 0) / qualifying.length;
  const totalSl = qualifying.reduce((s, b) => s + b.sl, 0);
  const totalN = qualifying.reduce((s, b) => s + b.total, 0);
  const pooled = totalSl / totalN;
  const obsVar = variance(rates)!;
  const expVar = (pooled * (1 - pooled)) / meanN;
  const ratio = expVar > 1e-9 ? obsVar / expVar : null;
  let flag: ClusteringFlag = 'independent';
  if (ratio != null) {
    if (ratio >= 1.5) flag = 'clustered';
    else if (ratio <= 0.5) flag = 'under-dispersed';
  }
  return {
    windows_used: qualifying.length,
    windows_skipped_low_n: skipped,
    mean_window_n: +meanN.toFixed(2),
    pooled_sl_rate: +pooled.toFixed(4),
    observed_variance: +obsVar.toFixed(6),
    poisson_expected_variance: +expVar.toFixed(6),
    variance_ratio: ratio == null ? null : +ratio.toFixed(3),
    flag,
  };
}

function exitMixByBucket<T extends string | number>(
  trades: TradeRow[],
  bucketFn: (t: TradeRow) => T,
  formatBucket: (b: T) => string,
): ExitMixCell[] {
  const map = new Map<T, ExitMixCell>();
  for (const t of trades) {
    const b = bucketFn(t);
    if (!map.has(b)) {
      map.set(b, {
        bucket: formatBucket(b),
        n: 0,
        take_profit: 0, stop_loss: 0, trailing_stop: 0,
        trailing_tp: 0, breakeven_stop: 0, timeout: 0, other: 0,
      });
    }
    const cell = map.get(b)!;
    cell.n += 1;
    switch (t.exit_reason) {
      case 'take_profit': cell.take_profit += 1; break;
      case 'stop_loss': cell.stop_loss += 1; break;
      case 'trailing_stop': cell.trailing_stop += 1; break;
      case 'trailing_tp': cell.trailing_tp += 1; break;
      case 'breakeven_stop': cell.breakeven_stop += 1; break;
      case 'timeout': cell.timeout += 1; break;
      default: cell.other += 1;
    }
  }
  const keys = Array.from(map.keys()).sort((a, b) => (a as number | string) > (b as number | string) ? 1 : -1);
  return keys.map(k => map.get(k)!);
}

// ── Main compute ──────────────────────────────────────────────────────────

export function computeSlPrecursor(db: Database.Database): SlPrecursorData {
  const generated_at = new Date().toISOString();

  // Strategies with >= MIN_TRADES_PER_STRATEGY closed trades.
  const eligibleRows = db.prepare(`
    SELECT strategy_id, COUNT(*) AS n
    FROM trades_v2
    WHERE status = 'closed'
      AND entry_timestamp IS NOT NULL
      AND exit_timestamp IS NOT NULL
      AND exit_reason IS NOT NULL
    GROUP BY strategy_id
    HAVING n >= ?
  `).all(MIN_TRADES_PER_STRATEGY) as Array<{ strategy_id: string; n: number }>;

  if (eligibleRows.length === 0) {
    return {
      generated_at,
      config: {
        min_trades_per_strategy: MIN_TRADES_PER_STRATEGY,
        precursor_min_cohort: PRECURSOR_MIN_COHORT,
        precursor_d_threshold: PRECURSOR_D_THRESHOLD,
        cluster_window_sec: CLUSTER_WINDOW_SEC,
        cluster_min_trades_per_window: CLUSTER_MIN_TRADES_PER_WINDOW,
        near_miss_pct_of_sl: NEAR_MISS_PCT_OF_SL,
      },
      strategies: [],
      notes: [`No strategies with >= ${MIN_TRADES_PER_STRATEGY} closed trades yet.`],
    };
  }

  const labelMap = new Map<string, string>(
    (db.prepare(`SELECT id, label FROM strategy_configs`).all() as Array<{ id: string; label: string }>)
      .map(r => [r.id, r.label]),
  );

  const strategyIds = eligibleRows.map(r => r.strategy_id);
  const placeholders = strategyIds.map(() => '?').join(',');

  // Pull all closed trades for the eligible strategies, joined with the
  // graduation timestamp + precursor features in one shot. Avoids N+1 queries.
  const featCols = PRECURSOR_FEATURES.map(f => `gm.${f}`).join(', ');
  const checkpointCols = CHECKPOINTS.map(c => `gm.${c.col}`).join(', ');
  const tradeRows = db.prepare(`
    SELECT
      t.id, t.strategy_id, t.graduation_id, t.mint,
      t.entry_timestamp, t.exit_timestamp,
      t.entry_price_sol, t.stop_loss_pct,
      t.net_profit_sol, t.net_return_pct, t.exit_reason,
      (t.exit_timestamp - t.entry_timestamp) AS held_seconds,
      g.timestamp AS graduation_ts,
      ${featCols},
      ${checkpointCols}
    FROM trades_v2 t
    JOIN graduations g ON g.id = t.graduation_id
    LEFT JOIN graduation_momentum gm ON gm.graduation_id = t.graduation_id
    WHERE t.status = 'closed'
      AND t.entry_timestamp IS NOT NULL
      AND t.exit_timestamp IS NOT NULL
      AND t.exit_reason IS NOT NULL
      AND t.net_return_pct IS NOT NULL
      AND t.strategy_id IN (${placeholders})
  `).all(...strategyIds) as Array<TradeRow & {
    graduation_ts: number;
    [key: string]: any;
  }>;

  const byStrategy = new Map<string, typeof tradeRows>();
  for (const r of tradeRows) {
    if (!byStrategy.has(r.strategy_id)) byStrategy.set(r.strategy_id, []);
    byStrategy.get(r.strategy_id)!.push(r);
  }

  const strategies: StrategySlPrecursor[] = [];

  for (const sid of strategyIds) {
    const rows = byStrategy.get(sid) ?? [];
    if (rows.length === 0) continue;

    const slTrades = rows.filter(r => r.exit_reason === 'stop_loss');
    const tpTrades = rows.filter(r => r.exit_reason === 'take_profit');

    // 1. Time-to-SL distribution
    const ttsl = timeToSlBuckets(slTrades, slTrades.length);

    // 2. Precursor signature
    const precursors: PrecursorFeatureRow[] = PRECURSOR_FEATURES.map(feat => {
      const slVals = slTrades.map(r => r[feat] as number | null).filter((v): v is number => v != null && Number.isFinite(v));
      const tpVals = tpTrades.map(r => r[feat] as number | null).filter((v): v is number => v != null && Number.isFinite(v));
      const d = cohensD(slVals, tpVals);
      const slMean = mean(slVals);
      const tpMean = mean(tpVals);
      const notable = d != null
        && Math.abs(d) > PRECURSOR_D_THRESHOLD
        && slVals.length >= PRECURSOR_MIN_COHORT
        && tpVals.length >= PRECURSOR_MIN_COHORT;
      return {
        feature: feat,
        sl_n: slVals.length,
        tp_n: tpVals.length,
        sl_mean: slMean == null ? null : +slMean.toFixed(4),
        tp_mean: tpMean == null ? null : +tpMean.toFixed(4),
        cohens_d: d == null ? null : +d.toFixed(3),
        notable,
      };
    });
    const topPrecursors = precursors
      .filter(p => p.notable)
      .sort((a, b) => Math.abs(b.cohens_d!) - Math.abs(a.cohens_d!))
      .slice(0, 3);

    // 3. Clustering test
    const clustering = clusteringTest(rows);

    // 4. Near-miss recoveries (winners only)
    const winners = rows.filter(r => r.exit_reason === 'take_profit'
      || r.exit_reason === 'trailing_tp'
      || r.net_return_pct > 0);
    const nearMissRows: NearMissRow[] = [];
    let winnersChecked = 0;
    for (const w of winners) {
      if (w.stop_loss_pct == null || w.entry_price_sol == null) continue;
      const slPrice = w.entry_price_sol * (1 - w.stop_loss_pct / 100);
      if (slPrice <= 0) continue;
      // Convert position window to T+offsets from graduation.
      const entryOff = w.entry_timestamp - w.graduation_ts;
      const exitOff = w.exit_timestamp - w.graduation_ts;
      let intraLow: number | null = null;
      let intraLowSec = -1;
      for (const cp of CHECKPOINTS) {
        if (cp.sec < entryOff || cp.sec > exitOff) continue;
        const p = w[cp.col] as number | null;
        if (p == null || !Number.isFinite(p) || p <= 0) continue;
        if (intraLow == null || p < intraLow) {
          intraLow = p;
          intraLowSec = cp.sec;
        }
      }
      if (intraLow == null) continue;
      winnersChecked += 1;
      const pctAbove = ((intraLow - slPrice) / slPrice) * 100;
      if (pctAbove <= NEAR_MISS_PCT_OF_SL && pctAbove >= 0) {
        nearMissRows.push({
          trade_id: w.id,
          mint: w.mint,
          graduation_id: w.graduation_id,
          entry_price_sol: w.entry_price_sol,
          intra_low_price_sol: +intraLow.toFixed(9),
          intra_low_at_t_sec: intraLowSec,
          sl_price_sol: +slPrice.toFixed(9),
          pct_above_sl: +pctAbove.toFixed(3),
          net_return_pct: w.net_return_pct,
          exit_reason: w.exit_reason,
        });
      }
    }
    nearMissRows.sort((a, b) => a.pct_above_sl - b.pct_above_sl);

    // 5. Exit-reason mix by calendar bucket (anchored on entry time, UTC)
    const exitMixDow = exitMixByBucket(
      rows,
      r => bucketByDow(r.entry_timestamp),
      (b: number) => DOW_LABELS[b],
    );
    const exitMixHour = exitMixByBucket(
      rows,
      r => bucketByHour(r.entry_timestamp),
      (b: number) => `${String(b).padStart(2, '0')}:00`,
    );

    strategies.push({
      strategy_id: sid,
      label: labelMap.get(sid) ?? sid,
      n_closed: rows.length,
      n_sl: slTrades.length,
      sl_rate_pct: +((slTrades.length / rows.length) * 100).toFixed(2),
      time_to_sl: ttsl,
      precursors,
      top_precursors: topPrecursors,
      clustering,
      near_miss: {
        n_winners_checked: winnersChecked,
        n_near_miss: nearMissRows.length,
        threshold_pct: NEAR_MISS_PCT_OF_SL,
        rows: nearMissRows.slice(0, 20),
      },
      exit_mix_by_dow: exitMixDow,
      exit_mix_by_hour: exitMixHour,
    });
  }

  // Sort: strategies with the most notable precursors first, then by sl_rate desc.
  strategies.sort((a, b) => {
    const ap = a.top_precursors.length;
    const bp = b.top_precursors.length;
    if (ap !== bp) return bp - ap;
    return b.sl_rate_pct - a.sl_rate_pct;
  });

  return {
    generated_at,
    config: {
      min_trades_per_strategy: MIN_TRADES_PER_STRATEGY,
      precursor_min_cohort: PRECURSOR_MIN_COHORT,
      precursor_d_threshold: PRECURSOR_D_THRESHOLD,
      cluster_window_sec: CLUSTER_WINDOW_SEC,
      cluster_min_trades_per_window: CLUSTER_MIN_TRADES_PER_WINDOW,
      near_miss_pct_of_sl: NEAR_MISS_PCT_OF_SL,
    },
    strategies,
    notes: [
      'Strategy gate: requires >= 50 closed trades.',
      'Precursor features are all T+30-known (no look-ahead). Cohen\'s d is (mean_SL - mean_TP) / pooled_sd; |d|>0.3 with both cohorts >=10 is "notable".',
      'Clustering: 30-min entry-time bins; variance ratio = observed_var(sl_rate) / poisson_expected_var. >=1.5 → clustered (regime memory); <=0.5 → under-dispersed.',
      'Near-miss: for winning trades, intra-position low is the minimum sampled checkpoint price in [entry, exit]. "Near-miss" = drew within 1.0% above SL price and still exited as winner. Top 20 closest surfaced per strategy.',
      'Exit-mix calendar bucketing is anchored on entry_timestamp UTC.',
    ],
  };
}
