import type Database from 'better-sqlite3';

/**
 * Regime Analysis.
 *
 * Phase 1 of the regime-detection plan: compute leading universe-level signals
 * that indicate whether the post-graduation tape is favorable (GREEN) or
 * unfavorable (RED). Overlays cumulative live-strategy net SOL on the same
 * timeline so we can visually validate whether the signals lead or lag actual
 * live P&L.
 *
 * Signals (all derived from graduation_momentum, no new collection needed):
 *   - pump_rate     — % of grads in the window with pct_t300 >= +50%
 *   - fast_rug_rate — % of grads with pct_t300 <= -50%  (proxy for hard rugs)
 *   - median_vol    — median sum_abs_returns_0_30 (universe whippiness proxy)
 *   - median_t300   — median pct_t300 (raw tape return)
 *
 * Regime classification (per hourly bucket):
 *   GREEN  — pump_rate >= 25% AND fast_rug_rate <= 35%
 *   RED    — pump_rate < 15%  OR fast_rug_rate > 50%
 *   YELLOW — anything in between
 *
 * Thresholds are intentionally simple and stable so the signal is interpretable
 * (and so swap-in regime-soft-gate logic can use the same numbers). Phase 2
 * could move to percentile-based thresholds once we have ≥2 weeks of saved
 * timeline + live PnL data.
 */

const HOUR_SEC = 3600;
const WINDOW_GRADS = 50;       // rolling window for "current signals"
const TIMELINE_DAYS = 14;      // how far back to compute the hourly timeline
const TIMELINE_BUCKETS = TIMELINE_DAYS * 24;
const PUMP_PCT = 50;           // pct_t300 >= this counts as a pump
const RUG_PCT = -50;           // pct_t300 <= this counts as a rug
// Thresholds (recalibrated 2026-05-31 after 14-day data review):
//   - GREEN_PUMP_MIN lowered 25 → 20: the 25% bar only fired on 3% of hours,
//     leaving the GREEN bucket too rare to validate. n=20 widens it to a
//     usable ~15-25% of hours while still requiring above-baseline pump activity
//     (baseline median pump rate ran ~14-15% over the window).
//   - GREEN_RUG_MAX tightened 35 → 25: pairs with the lower pump bar so GREEN
//     means "above-baseline pumps AND below-baseline rugs" simultaneously.
//   - RED_RUG_MIN lowered 50 → 35: the 50% bar never fired in 14 days (max
//     observed rug rate in the worst hours was 42%). 35 puts it within the
//     observed range so the rug signal can actually contribute to RED calls.
//   - RED_PUMP_MAX unchanged at 15: confirmed working — every worst-10 hour
//     had pump_rate <= 22% and the pump component carried the entire RED
//     classification in the prior analysis window.
const GREEN_PUMP_MIN = 20;
const RED_PUMP_MAX = 15;
const GREEN_RUG_MAX = 25;
const RED_RUG_MIN = 35;

export type Regime = 'GREEN' | 'YELLOW' | 'RED';

export interface RegimeAnalysisData {
  generated_at: string;
  config: {
    pump_pct_threshold: number;
    rug_pct_threshold: number;
    green_pump_min: number;
    red_pump_max: number;
    green_rug_max: number;
    red_rug_min: number;
    window_grads: number;
    timeline_days: number;
  };
  current: {
    regime: Regime;
    pump_rate: number;
    fast_rug_rate: number;
    median_vol: number | null;
    median_t300: number | null;
    n_window: number;
    last_grad_ts: number | null;
  };
  timeline: TimelineBucket[];
  live_strategies: LiveStrategyRow[];
  signal_vs_pnl: SignalCorrelationRow[];
  recent_transitions: RegimeTransition[];
  worst_hours: WorstHourRow[];
  by_dow: Array<{ dow: number; label: string; avg_pump_rate: number; avg_rug_rate: number; n_grads: number }>;
  by_hour: Array<{ hour: number; avg_pump_rate: number; avg_rug_rate: number; n_grads: number }>;
  regime_summary: {
    green_pct: number;
    yellow_pct: number;
    red_pct: number;
    green_avg_live_sol_per_hr: number | null;
    yellow_avg_live_sol_per_hr: number | null;
    red_avg_live_sol_per_hr: number | null;
  };
  notes: string[];
}

export interface TimelineBucket {
  bucket_start: number;    // unix ts (UTC)
  iso: string;
  n_grads: number;
  pump_rate: number | null;
  fast_rug_rate: number | null;
  median_vol: number | null;
  median_t300: number | null;
  regime: Regime;
  // Total live net SOL across all live_micro/live strategies in this bucket
  live_net_sol: number;
  live_trade_count: number;
}

export interface LiveStrategyRow {
  strategy_id: string;
  label: string;
  execution_mode: string;
  n_trades: number;
  total_net_sol: number;
  first_trade_ts: number | null;
  last_trade_ts: number | null;
  // Hourly cumulative net SOL — same x-axis as timeline
  cum_net_sol: Array<{ ts: number; cum: number }>;
  // Per-hour delta net SOL (only buckets with trades) — for per-strategy
  // worst-hour recomputation in the UI filter.
  hourly_net_sol: Array<{ ts: number; sol: number; n: number; regime: Regime; pump_rate: number | null; fast_rug_rate: number | null; median_t300: number | null }>;
  // Per-regime breakdown
  green_net_sol: number;
  green_n: number;
  green_hours_active: number;  // # of distinct hours w/ at least 1 trade
  yellow_net_sol: number;
  yellow_n: number;
  yellow_hours_active: number;
  red_net_sol: number;
  red_n: number;
  red_hours_active: number;
}

export interface SignalCorrelationRow {
  strategy_id: string;
  // For each lag (0..6 hours), the Pearson correlation between the regime
  // signal at time t-lag and the strategy's per-hour net SOL at time t.
  // Positive lag = signal leads. Best_lag = the lag with the largest |corr|.
  pump_rate_corr: Array<{ lag_hours: number; corr: number | null; n: number }>;
  rug_rate_corr: Array<{ lag_hours: number; corr: number | null; n: number }>;
  best_pump_lag: number | null;
  best_pump_corr: number | null;
  best_rug_lag: number | null;
  best_rug_corr: number | null;
}

export interface RegimeTransition {
  ts: number;
  iso: string;
  from: Regime;
  to: Regime;
  pump_rate: number | null;
  fast_rug_rate: number | null;
}

export interface WorstHourRow {
  bucket_start: number;
  iso: string;
  live_net_sol: number;
  live_trade_count: number;
  regime: Regime;
  pump_rate: number | null;
  fast_rug_rate: number | null;
  median_t300: number | null;
}

interface GradRow {
  created_at: number;
  pct_t300: number | null;
  sum_abs: number | null;
}

interface LiveTradeRow {
  strategy_id: string;
  execution_mode: string;
  exit_timestamp: number;
  net_profit_sol: number;
}

function classify(pumpRate: number | null, fastRugRate: number | null): Regime {
  if (pumpRate == null || fastRugRate == null) return 'YELLOW';
  if (pumpRate < RED_PUMP_MAX || fastRugRate > RED_RUG_MIN) return 'RED';
  if (pumpRate >= GREEN_PUMP_MIN && fastRugRate <= GREEN_RUG_MAX) return 'GREEN';
  return 'YELLOW';
}

// ── Lightweight current-regime accessor (for entry-time gating) ────────────
// Strategies that opt in to regime gating call this from trade-evaluator.
// Cached with a 60s TTL so a busy graduation hour doesn't slam the DB.
// Pulls only the last WINDOW_GRADS complete grads (one indexed SQL query)
// vs the full computeRegimeAnalysis which walks 30+ days for the timeline.

export interface CurrentRegimeSnapshot {
  regime: Regime;
  pump_rate: number;
  fast_rug_rate: number;
  median_t300: number | null;
  n_window: number;
  computed_at_ms: number;
}

let cachedCurrent: CurrentRegimeSnapshot | null = null;
const CURRENT_REGIME_CACHE_TTL_MS = 60_000;

export function getCurrentRegime(db: import('better-sqlite3').Database): CurrentRegimeSnapshot {
  if (cachedCurrent && Date.now() - cachedCurrent.computed_at_ms < CURRENT_REGIME_CACHE_TTL_MS) {
    return cachedCurrent;
  }
  const rows = db.prepare(`
    SELECT pct_t300, sum_abs_returns_0_30 AS sum_abs
    FROM graduation_momentum
    WHERE pct_t300 IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(WINDOW_GRADS) as Array<{ pct_t300: number; sum_abs: number | null }>;

  if (rows.length < 10) {
    // Insufficient sample — permissive default. Logged at caller.
    cachedCurrent = {
      regime: 'YELLOW',
      pump_rate: 0,
      fast_rug_rate: 0,
      median_t300: null,
      n_window: rows.length,
      computed_at_ms: Date.now(),
    };
    return cachedCurrent;
  }

  const pumps = rows.filter(r => r.pct_t300 >= PUMP_PCT).length;
  const rugs = rows.filter(r => r.pct_t300 <= RUG_PCT).length;
  const pumpRate = +(100 * pumps / rows.length).toFixed(1);
  const rugRate = +(100 * rugs / rows.length).toFixed(1);
  const medT300 = median(rows.map(r => r.pct_t300));
  cachedCurrent = {
    regime: classify(pumpRate, rugRate),
    pump_rate: pumpRate,
    fast_rug_rate: rugRate,
    median_t300: medT300 != null ? +medT300.toFixed(2) : null,
    n_window: rows.length,
    computed_at_ms: Date.now(),
  };
  return cachedCurrent;
}

/** Test/utility: drop the cache. Production never needs this. */
export function _resetCurrentRegimeCache(): void {
  cachedCurrent = null;
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function mean(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 4) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  if (den === 0) return null;
  return +(num / den).toFixed(3);
}

function floorHour(ts: number): number {
  return Math.floor(ts / HOUR_SEC) * HOUR_SEC;
}

export function computeRegimeAnalysis(db: Database.Database): RegimeAnalysisData {
  const generated_at = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  const timelineStart = floorHour(nowSec) - TIMELINE_BUCKETS * HOUR_SEC;

  // ─── 1. Pull graduations with pct_t300 in the timeline window ─────────────
  // We need every row to fill timeline buckets + a small lookback so the
  // earliest buckets can see their rolling-window context.
  const lookbackStart = timelineStart - WINDOW_GRADS * 600; // ~50 grads of buffer
  const grads = db.prepare(`
    SELECT
      created_at,
      pct_t300,
      sum_abs_returns_0_30 AS sum_abs
    FROM graduation_momentum
    WHERE created_at >= ?
    ORDER BY created_at ASC
  `).all(lookbackStart) as GradRow[];

  // ─── 2. Current rolling signals (last WINDOW_GRADS complete grads) ────────
  // "Complete" = has a non-null pct_t300 (i.e. T+300 has been reached).
  const completeGrads = grads.filter(g => g.pct_t300 != null);
  const recentWindow = completeGrads.slice(-WINDOW_GRADS);
  const currentPumps = recentWindow.filter(g => (g.pct_t300 ?? 0) >= PUMP_PCT).length;
  const currentRugs = recentWindow.filter(g => (g.pct_t300 ?? 0) <= RUG_PCT).length;
  const currentPumpRate = recentWindow.length > 0 ? +(100 * currentPumps / recentWindow.length).toFixed(1) : 0;
  const currentRugRate = recentWindow.length > 0 ? +(100 * currentRugs / recentWindow.length).toFixed(1) : 0;
  const currentMedVol = median(recentWindow.map(g => g.sum_abs).filter((v): v is number => v != null));
  const currentMedT300 = median(recentWindow.map(g => g.pct_t300).filter((v): v is number => v != null));
  const currentRegime = recentWindow.length >= 10 ? classify(currentPumpRate, currentRugRate) : 'YELLOW';

  // ─── 3. Pull live trades for the timeline window ──────────────────────────
  // Live = execution_mode IN ('live', 'live_micro'). Cumulative SOL is built
  // per strategy below; per-bucket aggregates are summed across strategies.
  const liveTrades = db.prepare(`
    SELECT
      strategy_id,
      COALESCE(execution_mode, 'paper') AS execution_mode,
      exit_timestamp,
      COALESCE(net_profit_sol, 0) AS net_profit_sol
    FROM trades_v2
    WHERE status = 'closed'
      AND (archived IS NULL OR archived = 0)
      AND exit_timestamp IS NOT NULL
      AND execution_mode IN ('live', 'live_micro')
    ORDER BY exit_timestamp ASC
  `).all() as LiveTradeRow[];

  // ─── 4. Build hourly timeline ─────────────────────────────────────────────
  // For each bucket: count grads in [start, end), compute rolling pump/rug
  // rate over the last WINDOW_GRADS *complete* grads up to bucket end, then
  // classify regime. Sum live net SOL of trades that exited in the bucket.
  const timeline: TimelineBucket[] = [];

  // Pre-index liveTrades by hour bucket for O(1) lookup.
  const tradesByBucket = new Map<number, LiveTradeRow[]>();
  for (const t of liveTrades) {
    const b = floorHour(t.exit_timestamp);
    if (!tradesByBucket.has(b)) tradesByBucket.set(b, []);
    tradesByBucket.get(b)!.push(t);
  }

  // Walk grads with a running window pointer for efficiency.
  let windowEnd = 0; // index into completeGrads
  for (let i = 0; i < TIMELINE_BUCKETS; i++) {
    const bucketStart = timelineStart + i * HOUR_SEC;
    const bucketEnd = bucketStart + HOUR_SEC;

    // Advance windowEnd to include all complete grads with created_at < bucketEnd.
    while (windowEnd < completeGrads.length && completeGrads[windowEnd].created_at < bucketEnd) {
      windowEnd++;
    }
    const windowStart = Math.max(0, windowEnd - WINDOW_GRADS);
    const win = completeGrads.slice(windowStart, windowEnd);

    const nGradsInBucket = grads.filter(g =>
      g.created_at >= bucketStart && g.created_at < bucketEnd
    ).length;

    let pumpRate: number | null = null;
    let rugRate: number | null = null;
    let medVol: number | null = null;
    let medT300: number | null = null;
    if (win.length >= 10) {
      const pumps = win.filter(g => (g.pct_t300 ?? 0) >= PUMP_PCT).length;
      const rugs = win.filter(g => (g.pct_t300 ?? 0) <= RUG_PCT).length;
      pumpRate = +(100 * pumps / win.length).toFixed(1);
      rugRate = +(100 * rugs / win.length).toFixed(1);
      medVol = median(win.map(g => g.sum_abs).filter((v): v is number => v != null));
      medT300 = median(win.map(g => g.pct_t300).filter((v): v is number => v != null));
    }
    const regime = classify(pumpRate, rugRate);

    const bucketTrades = tradesByBucket.get(bucketStart) ?? [];
    const liveNetSol = +bucketTrades.reduce((s, t) => s + t.net_profit_sol, 0).toFixed(4);

    timeline.push({
      bucket_start: bucketStart,
      iso: new Date(bucketStart * 1000).toISOString(),
      n_grads: nGradsInBucket,
      pump_rate: pumpRate,
      fast_rug_rate: rugRate,
      median_vol: medVol != null ? +medVol.toFixed(2) : null,
      median_t300: medT300 != null ? +medT300.toFixed(2) : null,
      regime,
      live_net_sol: liveNetSol,
      live_trade_count: bucketTrades.length,
    });
  }

  // ─── 5. Per-strategy live aggregates + cumulative net SOL ─────────────────
  // Group live trades by (strategy_id, execution_mode), build cumulative net SOL
  // series at hour resolution, and compute per-regime breakdowns.
  const liveStrategiesMap = new Map<string, LiveTradeRow[]>();
  for (const t of liveTrades) {
    const key = `${t.strategy_id}|${t.execution_mode}`;
    if (!liveStrategiesMap.has(key)) liveStrategiesMap.set(key, []);
    liveStrategiesMap.get(key)!.push(t);
  }

  // Label lookup
  const labels = db.prepare(`SELECT id, label FROM strategy_configs`).all() as Array<{ id: string; label: string }>;
  const labelMap = new Map(labels.map(s => [s.id, s.label]));

  // Per-bucket lookup so we can attach the regime + signals to each
  // strategy's hourly trade aggregate (used by the UI filter to recompute
  // worst-hours when a single strategy is selected).
  const bucketLookup = new Map<number, { regime: Regime; pump_rate: number | null; fast_rug_rate: number | null; median_t300: number | null }>();
  for (const b of timeline) bucketLookup.set(b.bucket_start, {
    regime: b.regime, pump_rate: b.pump_rate, fast_rug_rate: b.fast_rug_rate, median_t300: b.median_t300,
  });

  const liveStrategies: LiveStrategyRow[] = [];
  for (const [key, trades] of liveStrategiesMap) {
    const [strategyId, executionMode] = key.split('|');
    trades.sort((a, b) => a.exit_timestamp - b.exit_timestamp);

    // Cumulative + delta series per timeline bucket.
    const cumByBucket: number[] = new Array(TIMELINE_BUCKETS).fill(0);
    const deltaByBucket: number[] = new Array(TIMELINE_BUCKETS).fill(0);
    const nByBucket: number[] = new Array(TIMELINE_BUCKETS).fill(0);
    let running = 0;
    let tradeIdx = 0;
    for (let i = 0; i < TIMELINE_BUCKETS; i++) {
      const bucketStart = timelineStart + i * HOUR_SEC;
      const bucketEnd = bucketStart + HOUR_SEC;
      while (tradeIdx < trades.length && trades[tradeIdx].exit_timestamp < bucketEnd) {
        running += trades[tradeIdx].net_profit_sol;
        deltaByBucket[i] += trades[tradeIdx].net_profit_sol;
        nByBucket[i] += 1;
        tradeIdx++;
      }
      cumByBucket[i] = +running.toFixed(4);
    }
    const cum_net_sol = cumByBucket.map((cum, i) => ({
      ts: timelineStart + i * HOUR_SEC,
      cum,
    }));

    // Hourly P&L deltas — only buckets where the strategy traded. Each row
    // carries the regime + signals so the UI can render a filtered worst-hours
    // table without recomputing on the server.
    const hourly_net_sol: LiveStrategyRow['hourly_net_sol'] = [];
    for (let i = 0; i < TIMELINE_BUCKETS; i++) {
      if (nByBucket[i] === 0) continue;
      const ts = timelineStart + i * HOUR_SEC;
      const ctx = bucketLookup.get(ts);
      hourly_net_sol.push({
        ts,
        sol: +deltaByBucket[i].toFixed(4),
        n: nByBucket[i],
        regime: ctx?.regime ?? 'YELLOW',
        pump_rate: ctx?.pump_rate ?? null,
        fast_rug_rate: ctx?.fast_rug_rate ?? null,
        median_t300: ctx?.median_t300 ?? null,
      });
    }

    // Per-regime aggregate (trade-count + active-hours so the UI can recompute
    // avg_sol_per_hr for any single strategy without re-walking trades).
    let gSol = 0, gN = 0, gHrs = new Set<number>();
    let ySol = 0, yN = 0, yHrs = new Set<number>();
    let rSol = 0, rN = 0, rHrs = new Set<number>();
    for (const t of trades) {
      const bucket = floorHour(t.exit_timestamp);
      const ctx = bucketLookup.get(bucket);
      if (!ctx) continue;
      if (ctx.regime === 'GREEN')  { gSol += t.net_profit_sol; gN++; gHrs.add(bucket); }
      else if (ctx.regime === 'YELLOW') { ySol += t.net_profit_sol; yN++; yHrs.add(bucket); }
      else if (ctx.regime === 'RED')    { rSol += t.net_profit_sol; rN++; rHrs.add(bucket); }
    }

    liveStrategies.push({
      strategy_id: strategyId,
      label: labelMap.get(strategyId) ?? strategyId,
      execution_mode: executionMode,
      n_trades: trades.length,
      total_net_sol: +trades.reduce((s, t) => s + t.net_profit_sol, 0).toFixed(4),
      first_trade_ts: trades[0]?.exit_timestamp ?? null,
      last_trade_ts: trades[trades.length - 1]?.exit_timestamp ?? null,
      cum_net_sol,
      hourly_net_sol,
      green_net_sol: +gSol.toFixed(4),
      green_n: gN,
      green_hours_active: gHrs.size,
      yellow_net_sol: +ySol.toFixed(4),
      yellow_n: yN,
      yellow_hours_active: yHrs.size,
      red_net_sol: +rSol.toFixed(4),
      red_n: rN,
      red_hours_active: rHrs.size,
    });
  }
  // Sort by recent activity (most recent first)
  liveStrategies.sort((a, b) => (b.last_trade_ts ?? 0) - (a.last_trade_ts ?? 0));

  // ─── 6. Lag-correlation signal vs live PnL per strategy ───────────────────
  // For each strategy, build hourly net SOL series, then for lags 0..6 hours
  // compute Pearson(signal_at_t-lag, pnl_at_t). Skip strategies with too few
  // trade hours to be meaningful.
  const signal_vs_pnl: SignalCorrelationRow[] = [];
  for (const s of liveStrategies) {
    // Hourly net SOL series (one value per timeline bucket).
    const hourlyPnl: number[] = new Array(TIMELINE_BUCKETS).fill(0);
    for (const t of liveTrades) {
      if (t.strategy_id !== s.strategy_id || t.execution_mode !== s.execution_mode) continue;
      const idx = Math.floor((floorHour(t.exit_timestamp) - timelineStart) / HOUR_SEC);
      if (idx >= 0 && idx < TIMELINE_BUCKETS) hourlyPnl[idx] += t.net_profit_sol;
    }
    const pumpSeries = timeline.map(b => b.pump_rate);
    const rugSeries = timeline.map(b => b.fast_rug_rate);

    const pumpLags: Array<{ lag_hours: number; corr: number | null; n: number }> = [];
    const rugLags: Array<{ lag_hours: number; corr: number | null; n: number }> = [];
    let bestPumpLag: number | null = null, bestPumpCorr: number | null = null;
    let bestRugLag: number | null = null, bestRugCorr: number | null = null;

    for (let lag = 0; lag <= 6; lag++) {
      // Pair: signal at (t-lag) with PnL at t. Skip leading `lag` buckets.
      const xs: number[] = [];
      const xsRug: number[] = [];
      const ys: number[] = [];
      for (let i = lag; i < TIMELINE_BUCKETS; i++) {
        const pumpVal = pumpSeries[i - lag];
        const rugVal = rugSeries[i - lag];
        if (pumpVal == null || rugVal == null) continue;
        // Only include hours where the strategy actually had a trade — otherwise
        // we're correlating signal with zero (which biases toward 0).
        if (hourlyPnl[i] === 0) continue;
        xs.push(pumpVal);
        xsRug.push(rugVal);
        ys.push(hourlyPnl[i]);
      }
      const pCorr = pearson(xs, ys);
      const rCorr = pearson(xsRug, ys);
      pumpLags.push({ lag_hours: lag, corr: pCorr, n: xs.length });
      rugLags.push({ lag_hours: lag, corr: rCorr, n: xsRug.length });
      if (pCorr != null && (bestPumpCorr == null || Math.abs(pCorr) > Math.abs(bestPumpCorr))) {
        bestPumpCorr = pCorr; bestPumpLag = lag;
      }
      if (rCorr != null && (bestRugCorr == null || Math.abs(rCorr) > Math.abs(bestRugCorr))) {
        bestRugCorr = rCorr; bestRugLag = lag;
      }
    }
    signal_vs_pnl.push({
      strategy_id: s.strategy_id,
      pump_rate_corr: pumpLags,
      rug_rate_corr: rugLags,
      best_pump_lag: bestPumpLag,
      best_pump_corr: bestPumpCorr,
      best_rug_lag: bestRugLag,
      best_rug_corr: bestRugCorr,
    });
  }

  // ─── 7. Recent regime transitions ─────────────────────────────────────────
  const recent_transitions: RegimeTransition[] = [];
  let prevRegime: Regime = timeline[0]?.regime ?? 'YELLOW';
  for (const b of timeline.slice(1)) {
    if (b.regime !== prevRegime) {
      recent_transitions.push({
        ts: b.bucket_start,
        iso: b.iso,
        from: prevRegime,
        to: b.regime,
        pump_rate: b.pump_rate,
        fast_rug_rate: b.fast_rug_rate,
      });
      prevRegime = b.regime;
    }
  }
  // Keep last 20 most recent transitions
  const recent_transitions_trimmed = recent_transitions.slice(-20).reverse();

  // ─── 8. Worst hours ───────────────────────────────────────────────────────
  const worst_hours: WorstHourRow[] = timeline
    .filter(b => b.live_trade_count > 0)
    .sort((a, b) => a.live_net_sol - b.live_net_sol)
    .slice(0, 10)
    .map(b => ({
      bucket_start: b.bucket_start,
      iso: b.iso,
      live_net_sol: b.live_net_sol,
      live_trade_count: b.live_trade_count,
      regime: b.regime,
      pump_rate: b.pump_rate,
      fast_rug_rate: b.fast_rug_rate,
      median_t300: b.median_t300,
    }));

  // ─── 9. Day-of-week + hour-of-day patterns ────────────────────────────────
  const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowAcc: Array<{ pump: number[]; rug: number[]; n: number }> =
    Array.from({ length: 7 }, () => ({ pump: [], rug: [], n: 0 }));
  const hourAcc: Array<{ pump: number[]; rug: number[]; n: number }> =
    Array.from({ length: 24 }, () => ({ pump: [], rug: [], n: 0 }));
  for (const b of timeline) {
    if (b.pump_rate == null || b.fast_rug_rate == null) continue;
    const d = new Date(b.bucket_start * 1000);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    dowAcc[dow].pump.push(b.pump_rate);
    dowAcc[dow].rug.push(b.fast_rug_rate);
    dowAcc[dow].n += b.n_grads;
    hourAcc[hour].pump.push(b.pump_rate);
    hourAcc[hour].rug.push(b.fast_rug_rate);
    hourAcc[hour].n += b.n_grads;
  }
  const by_dow = dowAcc.map((a, i) => ({
    dow: i,
    label: dowLabels[i],
    avg_pump_rate: a.pump.length > 0 ? +(mean(a.pump)!).toFixed(1) : 0,
    avg_rug_rate: a.rug.length > 0 ? +(mean(a.rug)!).toFixed(1) : 0,
    n_grads: a.n,
  }));
  const by_hour = hourAcc.map((a, i) => ({
    hour: i,
    avg_pump_rate: a.pump.length > 0 ? +(mean(a.pump)!).toFixed(1) : 0,
    avg_rug_rate: a.rug.length > 0 ? +(mean(a.rug)!).toFixed(1) : 0,
    n_grads: a.n,
  }));

  // ─── 10. Regime summary (hours in each state + avg live SOL/hr) ───────────
  let gHours = 0, yHours = 0, rHours = 0;
  let gLiveSol = 0, gLiveHrs = 0, yLiveSol = 0, yLiveHrs = 0, rLiveSol = 0, rLiveHrs = 0;
  for (const b of timeline) {
    if (b.regime === 'GREEN')       { gHours++; if (b.live_trade_count > 0) { gLiveSol += b.live_net_sol; gLiveHrs++; } }
    else if (b.regime === 'YELLOW') { yHours++; if (b.live_trade_count > 0) { yLiveSol += b.live_net_sol; yLiveHrs++; } }
    else if (b.regime === 'RED')    { rHours++; if (b.live_trade_count > 0) { rLiveSol += b.live_net_sol; rLiveHrs++; } }
  }
  const totalHours = gHours + yHours + rHours;
  const regime_summary = {
    green_pct: totalHours > 0 ? +(100 * gHours / totalHours).toFixed(1) : 0,
    yellow_pct: totalHours > 0 ? +(100 * yHours / totalHours).toFixed(1) : 0,
    red_pct: totalHours > 0 ? +(100 * rHours / totalHours).toFixed(1) : 0,
    green_avg_live_sol_per_hr: gLiveHrs > 0 ? +(gLiveSol / gLiveHrs).toFixed(4) : null,
    yellow_avg_live_sol_per_hr: yLiveHrs > 0 ? +(yLiveSol / yLiveHrs).toFixed(4) : null,
    red_avg_live_sol_per_hr: rLiveHrs > 0 ? +(rLiveSol / rLiveHrs).toFixed(4) : null,
  };

  return {
    generated_at,
    config: {
      pump_pct_threshold: PUMP_PCT,
      rug_pct_threshold: RUG_PCT,
      green_pump_min: GREEN_PUMP_MIN,
      red_pump_max: RED_PUMP_MAX,
      green_rug_max: GREEN_RUG_MAX,
      red_rug_min: RED_RUG_MIN,
      window_grads: WINDOW_GRADS,
      timeline_days: TIMELINE_DAYS,
    },
    current: {
      regime: currentRegime,
      pump_rate: currentPumpRate,
      fast_rug_rate: currentRugRate,
      median_vol: currentMedVol != null ? +currentMedVol.toFixed(2) : null,
      median_t300: currentMedT300 != null ? +currentMedT300.toFixed(2) : null,
      n_window: recentWindow.length,
      last_grad_ts: completeGrads[completeGrads.length - 1]?.created_at ?? null,
    },
    timeline,
    live_strategies: liveStrategies,
    signal_vs_pnl,
    recent_transitions: recent_transitions_trimmed,
    worst_hours,
    by_dow,
    by_hour,
    regime_summary,
    notes: [
      `Signals: pump_rate = % of last ${WINDOW_GRADS} complete grads with pct_t300 >= +${PUMP_PCT}%; fast_rug_rate = % with pct_t300 <= ${RUG_PCT}%.`,
      `GREEN: pump_rate >= ${GREEN_PUMP_MIN}% AND fast_rug_rate <= ${GREEN_RUG_MAX}%.`,
      `RED: pump_rate < ${RED_PUMP_MAX}% OR fast_rug_rate > ${RED_RUG_MIN}%.`,
      `YELLOW: anything in between.`,
      `Timeline window: last ${TIMELINE_DAYS} days (${TIMELINE_BUCKETS} hourly buckets).`,
      `Lag correlation: positive lag = signal leads strategy P&L. Best_lag is the value of |corr| max across lags 0..6h.`,
      `Hours with zero live trades are excluded from lag correlation (otherwise the signal would correlate with zero PnL and dilute toward 0).`,
      `Phase 1 = research overlay only — no enforcement. Phase 2 = wire as soft size-reduction gate once lag-correlation confirms predictive signal.`,
    ],
  };
}
