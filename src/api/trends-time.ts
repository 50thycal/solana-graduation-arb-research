import type Database from 'better-sqlite3';

/**
 * Calendar / temporal trends panel. Buckets closed trades by:
 *   - day-of-week (Mon-Sun, UTC)
 *   - hour-of-day (0-23, UTC)
 *   - weekday vs weekend
 * Per bucket reports n, total_net_sol, win_rate (+ Wilson 95% CI), avg_net_pct,
 * drop_top3_net_sol. Also produces a "pacing" Pearson correlation between
 * graduations/day and per-strategy net_sol/day, and a per-strategy lag-1
 * autocorrelation on the daily net-SOL series.
 *
 * All bucketing is UTC. Cells with n < 5 report win_rate=null + low_sample=true
 * to avoid misleading point estimates.
 *
 * Exports `dailyNetSolByStrategy()` + `bucketByDow()` / `bucketByHour()` as
 * shared primitives used by Panel D (portfolio-corr) and Panel C
 * (sl-precursor exit-mix sub-panel) respectively.
 */

export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MIN_STRATEGY_TRADES = 30;
const LOW_SAMPLE_THRESHOLD = 5;
const AUTOCORR_MIN_DAYS = 14;

export interface BucketStats {
  n: number;
  total_net_sol: number;
  avg_net_pct: number | null;
  win_rate: number | null;
  win_rate_ci_lower: number | null;
  win_rate_ci_upper: number | null;
  drop_top3_net_sol: number;
  low_sample: boolean;
}

export interface DowBucketRow extends BucketStats {
  dow: number;
  label: string;
}

export interface HourBucketRow extends BucketStats {
  hour: number;
}

export interface PerStrategyBuckets {
  strategy_id: string;
  label: string;
  n_total: number;
  by_dow: DowBucketRow[];
  by_hour: HourBucketRow[];
  weekday: BucketStats;
  weekend: BucketStats;
  pacing_pearson: number | null;
  pacing_days_used: number;
  autocorr_lag1: number | null;
  autocorr_days_used: number;
}

export interface PacingPoint {
  date: string;
  graduations: number;
  net_sol: number;
}

export interface TrendsTimeData {
  generated_at: string;
  bucketing: 'UTC';
  total_closed_trades: number;
  aggregate: {
    by_dow: DowBucketRow[];
    by_hour: HourBucketRow[];
    weekday: BucketStats;
    weekend: BucketStats;
  };
  by_strategy: PerStrategyBuckets[];
  pacing_global: {
    pearson: number | null;
    days_used: number;
    series: PacingPoint[];
  };
  notes: string[];
}

interface TradeRow {
  strategy_id: string;
  exit_timestamp: number;
  entry_timestamp: number | null;
  net_profit_sol: number;
  net_return_pct: number;
}

// ── Time bucketing helpers (UTC) ──────────────────────────────────────────

/** Returns 0-6 (Sun=0..Sat=6) for the given unix-seconds timestamp, UTC. */
export function bucketByDow(unixSec: number): number {
  // Unix epoch (1970-01-01) was a Thursday (=4 in Sun-indexed scheme).
  const days = Math.floor(unixSec / 86400);
  return (((days + 4) % 7) + 7) % 7;
}

/** Returns 0-23 for the given unix-seconds timestamp, UTC. */
export function bucketByHour(unixSec: number): number {
  const sec = ((unixSec % 86400) + 86400) % 86400;
  return Math.floor(sec / 3600);
}

/** Returns 'YYYY-MM-DD' UTC date string for the given unix-seconds timestamp. */
function bucketByDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

// ── Stats helpers ─────────────────────────────────────────────────────────

/** Wilson score 95% CI for a binomial proportion. Returns [null, null] when n=0. */
function wilsonCi(successes: number, n: number): [number | null, number | null] {
  if (n === 0) return [null, null];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  const lo = (centre - margin) / denom;
  const hi = (centre + margin) / denom;
  return [+lo.toFixed(4), +hi.toFixed(4)];
}

/** Pearson correlation. Returns null if n<2 or either series has zero variance. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (denom < 1e-12) return null;
  const r = (n * sxy - sx * sy) / denom;
  return +r.toFixed(4);
}

function summarizeBucket(trades: TradeRow[]): BucketStats {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      total_net_sol: 0,
      avg_net_pct: null,
      win_rate: null,
      win_rate_ci_lower: null,
      win_rate_ci_upper: null,
      drop_top3_net_sol: 0,
      low_sample: true,
    };
  }
  const totalNet = trades.reduce((s, t) => s + t.net_profit_sol, 0);
  const avgPct = trades.reduce((s, t) => s + t.net_return_pct, 0) / n;
  const wins = trades.filter(t => t.net_return_pct > 0).length;
  const sortedSolDesc = trades.map(t => t.net_profit_sol).sort((a, b) => b - a);
  const dropTop3 = sortedSolDesc.slice(Math.min(3, sortedSolDesc.length))
    .reduce((s, v) => s + v, 0);
  const lowSample = n < LOW_SAMPLE_THRESHOLD;
  const [ciLo, ciHi] = wilsonCi(wins, n);

  return {
    n,
    total_net_sol: +totalNet.toFixed(6),
    avg_net_pct: +avgPct.toFixed(2),
    win_rate: lowSample ? null : +((wins / n) * 100).toFixed(2),
    win_rate_ci_lower: ciLo == null ? null : +(ciLo * 100).toFixed(2),
    win_rate_ci_upper: ciHi == null ? null : +(ciHi * 100).toFixed(2),
    drop_top3_net_sol: +dropTop3.toFixed(6),
    low_sample: lowSample,
  };
}

// ── Exported daily series helper (Panel D reuses this) ────────────────────

export interface DailyNetSolPoint {
  date: string;
  net_sol: number;
  n: number;
}

export function dailyNetSolByStrategy(
  db: Database.Database,
  strategyId?: string,
): DailyNetSolPoint[] {
  const where = strategyId
    ? `AND strategy_id = ?`
    : '';
  const params = strategyId ? [strategyId] : [];
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', exit_timestamp, 'unixepoch') AS date,
      SUM(net_profit_sol) AS net_sol,
      COUNT(*) AS n
    FROM trades_v2
    WHERE status = 'closed'
      AND exit_timestamp IS NOT NULL
      AND net_profit_sol IS NOT NULL
      ${where}
    GROUP BY date
    ORDER BY date ASC
  `).all(...params) as Array<{ date: string; net_sol: number; n: number }>;
  return rows.map(r => ({
    date: r.date,
    net_sol: +(r.net_sol ?? 0).toFixed(6),
    n: Number(r.n),
  }));
}

// ── Main compute ──────────────────────────────────────────────────────────

export function computeTrendsTime(db: Database.Database): TrendsTimeData {
  const generated_at = new Date().toISOString();

  const trades = db.prepare(`
    SELECT
      strategy_id,
      exit_timestamp,
      entry_timestamp,
      net_profit_sol,
      net_return_pct
    FROM trades_v2
    WHERE status = 'closed'
      AND exit_timestamp IS NOT NULL
      AND net_profit_sol IS NOT NULL
      AND net_return_pct IS NOT NULL
  `).all() as TradeRow[];

  if (trades.length === 0) {
    return {
      generated_at,
      bucketing: 'UTC',
      total_closed_trades: 0,
      aggregate: {
        by_dow: [],
        by_hour: [],
        weekday: summarizeBucket([]),
        weekend: summarizeBucket([]),
      },
      by_strategy: [],
      pacing_global: { pearson: null, days_used: 0, series: [] },
      notes: ['No closed trades — nothing to bucket.'],
    };
  }

  // Anchor temporal bucketing on entry_timestamp where present, else
  // exit_timestamp. Entry is what the operator actually controls; exit is just
  // when the position closed. Calendar-effect analysis is about "when did we
  // decide to enter".
  const tradeTime = (t: TradeRow): number => t.entry_timestamp ?? t.exit_timestamp;

  // ── Aggregate buckets across all strategies ──
  const aggregateDow: TradeRow[][] = Array.from({ length: 7 }, () => []);
  const aggregateHour: TradeRow[][] = Array.from({ length: 24 }, () => []);
  for (const t of trades) {
    const ts = tradeTime(t);
    aggregateDow[bucketByDow(ts)].push(t);
    aggregateHour[bucketByHour(ts)].push(t);
  }
  const aggregateWeekday: TradeRow[] = [];
  const aggregateWeekend: TradeRow[] = [];
  for (const t of trades) {
    const dow = bucketByDow(tradeTime(t));
    if (dow === 0 || dow === 6) aggregateWeekend.push(t);
    else aggregateWeekday.push(t);
  }

  const aggByDow: DowBucketRow[] = aggregateDow.map((bucket, dow) => ({
    dow,
    label: DOW_LABELS[dow],
    ...summarizeBucket(bucket),
  }));
  const aggByHour: HourBucketRow[] = aggregateHour.map((bucket, hour) => ({
    hour,
    ...summarizeBucket(bucket),
  }));

  // ── Per-strategy buckets (only strategies with >=30 closed trades) ──
  const byStrategyMap = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (!byStrategyMap.has(t.strategy_id)) byStrategyMap.set(t.strategy_id, []);
    byStrategyMap.get(t.strategy_id)!.push(t);
  }

  const strategyLabels = new Map<string, string>(
    (db.prepare(`SELECT id, label FROM strategy_configs`).all() as Array<{ id: string; label: string }>)
      .map(r => [r.id, r.label]),
  );

  // Graduations per UTC day (used for the global + per-strategy pacing
  // Pearson). One query, reused for every strategy.
  const gradsByDay = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', timestamp, 'unixepoch') AS date,
      COUNT(*) AS n
    FROM graduations
    GROUP BY date
  `).all() as Array<{ date: string; n: number }>;
  const gradsByDayMap = new Map(gradsByDay.map(r => [r.date, Number(r.n)]));

  const byStrategy: PerStrategyBuckets[] = [];
  for (const [strategyId, tradesForS] of byStrategyMap) {
    if (tradesForS.length < MIN_STRATEGY_TRADES) continue;

    const dowBuckets: TradeRow[][] = Array.from({ length: 7 }, () => []);
    const hourBuckets: TradeRow[][] = Array.from({ length: 24 }, () => []);
    const weekdayBucket: TradeRow[] = [];
    const weekendBucket: TradeRow[] = [];
    for (const t of tradesForS) {
      const ts = tradeTime(t);
      const dow = bucketByDow(ts);
      dowBuckets[dow].push(t);
      hourBuckets[bucketByHour(ts)].push(t);
      if (dow === 0 || dow === 6) weekendBucket.push(t);
      else weekdayBucket.push(t);
    }

    // Per-day net SOL series for this strategy. Build directly from the
    // in-memory trades to avoid a query per strategy.
    const dailyNetMap = new Map<string, { net: number; n: number }>();
    for (const t of tradesForS) {
      const d = bucketByDate(tradeTime(t));
      const cur = dailyNetMap.get(d) ?? { net: 0, n: 0 };
      cur.net += t.net_profit_sol;
      cur.n += 1;
      dailyNetMap.set(d, cur);
    }
    const dailyDates = Array.from(dailyNetMap.keys()).sort();

    // Pacing Pearson: per overlapping date, (graduations/day, strategy net/day).
    const pacingX: number[] = [];
    const pacingY: number[] = [];
    for (const d of dailyDates) {
      const g = gradsByDayMap.get(d);
      if (g == null) continue;
      pacingX.push(g);
      pacingY.push(dailyNetMap.get(d)!.net);
    }
    const pacingR = pacingX.length >= 3 ? pearson(pacingX, pacingY) : null;

    // Lag-1 autocorrelation on the strategy's daily net-SOL series.
    let acorr: number | null = null;
    if (dailyDates.length >= AUTOCORR_MIN_DAYS) {
      const series = dailyDates.map(d => dailyNetMap.get(d)!.net);
      const xs = series.slice(0, -1);
      const ys = series.slice(1);
      acorr = pearson(xs, ys);
    }

    byStrategy.push({
      strategy_id: strategyId,
      label: strategyLabels.get(strategyId) ?? strategyId,
      n_total: tradesForS.length,
      by_dow: dowBuckets.map((bucket, dow) => ({
        dow, label: DOW_LABELS[dow], ...summarizeBucket(bucket),
      })),
      by_hour: hourBuckets.map((bucket, hour) => ({
        hour, ...summarizeBucket(bucket),
      })),
      weekday: summarizeBucket(weekdayBucket),
      weekend: summarizeBucket(weekendBucket),
      pacing_pearson: pacingR,
      pacing_days_used: pacingX.length,
      autocorr_lag1: acorr,
      autocorr_days_used: dailyDates.length,
    });
  }

  // Sort by absolute weekday-vs-weekend net_sol gap so the most calendar-
  // sensitive strategies surface first.
  byStrategy.sort((a, b) => {
    const aGap = Math.abs(a.weekday.total_net_sol - a.weekend.total_net_sol);
    const bGap = Math.abs(b.weekday.total_net_sol - b.weekend.total_net_sol);
    return bGap - aGap;
  });

  // ── Global pacing series ──
  const allDailyNet = new Map<string, number>();
  for (const t of trades) {
    const d = bucketByDate(tradeTime(t));
    allDailyNet.set(d, (allDailyNet.get(d) ?? 0) + t.net_profit_sol);
  }
  const pacingDates = Array.from(allDailyNet.keys()).sort();
  const series: PacingPoint[] = [];
  const gx: number[] = [];
  const gy: number[] = [];
  for (const d of pacingDates) {
    const g = gradsByDayMap.get(d) ?? 0;
    const net = allDailyNet.get(d)!;
    series.push({ date: d, graduations: g, net_sol: +net.toFixed(6) });
    if (g > 0) { gx.push(g); gy.push(net); }
  }

  return {
    generated_at,
    bucketing: 'UTC',
    total_closed_trades: trades.length,
    aggregate: {
      by_dow: aggByDow,
      by_hour: aggByHour,
      weekday: summarizeBucket(aggregateWeekday),
      weekend: summarizeBucket(aggregateWeekend),
    },
    by_strategy: byStrategy,
    pacing_global: {
      pearson: gx.length >= 3 ? pearson(gx, gy) : null,
      days_used: gx.length,
      series,
    },
    notes: [
      'All bucketing is UTC. Trade is anchored on entry_timestamp (fallback exit_timestamp).',
      `Per-strategy rows include only strategies with >= ${MIN_STRATEGY_TRADES} closed trades.`,
      `Cells with n < ${LOW_SAMPLE_THRESHOLD} report win_rate=null + low_sample=true.`,
      'Win-rate CI is Wilson 95%; drop_top3_net_sol is total SOL after removing the 3 largest winners.',
      'pacing_pearson: Pearson(graduations/day, strategy net SOL/day) over overlapping dates (min 3 days).',
      `autocorr_lag1: Pearson of strategy's daily net-SOL series vs its own 1-day lag (min ${AUTOCORR_MIN_DAYS} days).`,
      'Per-strategy rows sorted by |weekday total_net_sol - weekend total_net_sol| (most calendar-sensitive first).',
    ],
  };
}
