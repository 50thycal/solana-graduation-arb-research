import Database from 'better-sqlite3';

/**
 * Per-active-strategy percentile breakdown of closed trade returns.
 *
 * Companion to /api/trades' `by_strategy` (mean-only) — adds median, p10/p25/
 * p75/p90, min/max, and std dev so wide-tail strategies (e.g. v10-best-single
 * with the −99..1000 entry gate) can be evaluated without a single +500%
 * outlier dominating the mean.
 *
 * Filtered to strategies currently enabled in `strategy_configs` so the panel
 * tracks the live cohort. Disabled strategies' historical trades stay in the
 * DB but drop off the panel automatically when toggled off.
 *
 * Numbers are computed for both gross_return_pct (raw entry-to-exit move) and
 * net_return_pct (after slippage / gap penalties / jito tips). The delta tells
 * you how much execution cost is eating into the strategy's edge.
 */

interface PercentileBlock {
  mean: number | null;
  median: number | null;
  std_dev: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

export interface StrategyPercentileRow {
  strategy_id: string;
  label: string;
  enabled: boolean;
  execution_mode: string;
  n_total: number;
  n_closed: number;
  n_open: number;
  n_failed: number;
  exit_reasons: {
    take_profit: number;
    stop_loss: number;
    trailing_stop: number;
    breakeven_stop: number;
    trailing_tp: number;
    timeout: number;
    killswitch: number;
  };
  net_return_pct: PercentileBlock;
  gross_return_pct: PercentileBlock;
  /** mean net minus mean gross — captures avg execution cost in pp */
  avg_execution_cost_pp: number | null;
  total_net_profit_sol: number;
  first_trade_ts: number | null;
  last_trade_ts: number | null;
  /** Top 3 trades by gross_return_pct desc — identify outlier-driven means. */
  top_winners: OutlierTrade[];
  /** Bottom 3 trades by gross_return_pct asc — diagnose worst losses. */
  top_losers: OutlierTrade[];
}

export interface StrategyPercentilesData {
  generated_at: string;
  active_strategy_count: number;
  total_closed_trades: number;
  rows: StrategyPercentileRow[];
  notes: string[];
}

function pickPercentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // Linear-interpolated percentile (NIST method): rank = (n−1) × p
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function describe(values: number[]): PercentileBlock {
  if (values.length === 0) {
    return { mean: null, median: null, std_dev: null, p10: null, p25: null, p75: null, p90: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  return {
    mean: +mean.toFixed(2),
    median: +(pickPercentile(sorted, 0.5) ?? 0).toFixed(2),
    std_dev: +std.toFixed(2),
    p10: +(pickPercentile(sorted, 0.10) ?? 0).toFixed(2),
    p25: +(pickPercentile(sorted, 0.25) ?? 0).toFixed(2),
    p75: +(pickPercentile(sorted, 0.75) ?? 0).toFixed(2),
    p90: +(pickPercentile(sorted, 0.90) ?? 0).toFixed(2),
    min: +sorted[0].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
}

interface TradeRow {
  trade_id: number;
  graduation_id: number | null;
  mint: string | null;
  strategy_id: string;
  status: string;
  execution_mode: string | null;
  net_return_pct: number | null;
  gross_return_pct: number | null;
  exit_reason: string | null;
  entry_timestamp: number | null;
  exit_timestamp: number | null;
  entry_pct_from_open: number | null;
  net_profit_sol: number | null;
}

/** A single notable trade — top winner or worst loser. */
export interface OutlierTrade {
  trade_id: number;
  graduation_id: number | null;
  mint: string | null;
  entry_pct_from_open: number | null;
  gross_return_pct: number | null;
  net_return_pct: number | null;
  exit_reason: string | null;
  held_seconds: number | null;
}

export function computeStrategyPercentiles(db: Database.Database): StrategyPercentilesData {
  const generated_at = new Date().toISOString();

  // Active strategies from strategy_configs (enabled = 1). Pull their labels
  // so the panel rows are self-explanatory without having to cross-reference
  // strategies.json.
  const activeStrategies = db.prepare(`
    SELECT id, label, enabled FROM strategy_configs WHERE enabled = 1
  `).all() as Array<{ id: string; label: string; enabled: number }>;

  if (activeStrategies.length === 0) {
    return {
      generated_at,
      active_strategy_count: 0,
      total_closed_trades: 0,
      rows: [],
      notes: ['No active strategies — toggle one on to populate this panel.'],
    };
  }

  const activeIds = activeStrategies.map(s => s.id);
  const placeholders = activeIds.map(() => '?').join(',');

  const trades = db.prepare(`
    SELECT
      id AS trade_id,
      graduation_id,
      mint,
      strategy_id,
      status,
      COALESCE(execution_mode, 'paper') AS execution_mode,
      net_return_pct,
      gross_return_pct,
      exit_reason,
      entry_timestamp,
      exit_timestamp,
      entry_pct_from_open,
      net_profit_sol
    FROM trades_v2
    WHERE strategy_id IN (${placeholders})
      AND (archived IS NULL OR archived = 0)
  `).all(...activeIds) as TradeRow[];

  // Bucket per (strategy_id, execution_mode). Same strategy can in principle
  // straddle modes if execution_mode was changed mid-life; treating each as
  // its own row matches getTradeStatsByStrategy.
  const buckets = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = `${t.strategy_id}|${t.execution_mode}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }

  const labelById = new Map(activeStrategies.map(s => [s.id, s.label]));

  const rows: StrategyPercentileRow[] = [];
  let totalClosed = 0;

  for (const [key, group] of buckets) {
    const [strategyId, executionMode] = key.split('|');
    const closed = group.filter(t => t.status === 'closed');
    const netReturns = closed
      .map(t => t.net_return_pct)
      .filter((v): v is number => v != null);
    const grossReturns = closed
      .map(t => t.gross_return_pct)
      .filter((v): v is number => v != null);

    totalClosed += closed.length;

    const netStats = describe(netReturns);
    const grossStats = describe(grossReturns);
    const avgExecCostPp = netStats.mean !== null && grossStats.mean !== null
      ? +(grossStats.mean - netStats.mean).toFixed(2)
      : null;

    const exitReasons = {
      take_profit: 0,
      stop_loss: 0,
      trailing_stop: 0,
      breakeven_stop: 0,
      trailing_tp: 0,
      timeout: 0,
      killswitch: 0,
    };
    for (const t of closed) {
      const r = t.exit_reason;
      if (r && r in exitReasons) (exitReasons as any)[r]++;
    }

    const totalProfit = closed.reduce((s, t) => s + (t.net_profit_sol ?? 0), 0);

    // Top 3 winners + bottom 3 losers by gross_return_pct so a future analyst
    // can drill in on outlier-driven mean / median divergences.
    const closedWithGross = closed.filter((t): t is TradeRow & { gross_return_pct: number } =>
      t.gross_return_pct != null);
    const toOutlier = (t: TradeRow): OutlierTrade => ({
      trade_id: t.trade_id,
      graduation_id: t.graduation_id,
      mint: t.mint,
      entry_pct_from_open: t.entry_pct_from_open,
      gross_return_pct: t.gross_return_pct,
      net_return_pct: t.net_return_pct,
      exit_reason: t.exit_reason,
      held_seconds: t.exit_timestamp != null && t.entry_timestamp != null
        ? t.exit_timestamp - t.entry_timestamp
        : null,
    });
    const topWinners = [...closedWithGross]
      .sort((a, b) => b.gross_return_pct - a.gross_return_pct)
      .slice(0, 3)
      .map(toOutlier);
    const topLosers = [...closedWithGross]
      .sort((a, b) => a.gross_return_pct - b.gross_return_pct)
      .slice(0, 3)
      .map(toOutlier);

    const entryTs = group.map(t => t.entry_timestamp).filter((v): v is number => v != null);
    const firstTs = entryTs.length > 0 ? Math.min(...entryTs) : null;
    const lastTs = entryTs.length > 0 ? Math.max(...entryTs) : null;

    rows.push({
      strategy_id: strategyId,
      label: labelById.get(strategyId) ?? strategyId,
      enabled: true,
      execution_mode: executionMode,
      n_total: group.length,
      n_closed: closed.length,
      n_open: group.filter(t => t.status === 'open').length,
      n_failed: group.filter(t => t.status === 'failed').length,
      exit_reasons: exitReasons,
      net_return_pct: netStats,
      gross_return_pct: grossStats,
      avg_execution_cost_pp: avgExecCostPp,
      total_net_profit_sol: +totalProfit.toFixed(4),
      first_trade_ts: firstTs,
      last_trade_ts: lastTs,
      top_winners: topWinners,
      top_losers: topLosers,
    });
  }

  // Sort by median net return desc — surfaces strategies whose typical trade
  // is best, not the ones whose mean is skewed by a single outlier. Strategies
  // with no closed trades sink to the bottom (median = null treated as -Inf).
  rows.sort((a, b) => {
    const am = a.net_return_pct.median ?? -Infinity;
    const bm = b.net_return_pct.median ?? -Infinity;
    return bm - am;
  });

  return {
    generated_at,
    active_strategy_count: activeStrategies.length,
    total_closed_trades: totalClosed,
    rows,
    notes: [
      'Filtered to currently-enabled strategies (strategy_configs.enabled = 1).',
      'Disabled strategies\' historical trades remain in trades_v2 but drop off this panel; toggle on to re-surface.',
      'Sorted by median net_return_pct desc — median is more robust than mean for strategies with the open -99..1000 entry gate.',
      'avg_execution_cost_pp = mean(gross) − mean(net). Captures slippage + jito + tx-fee drag in pp.',
      'Percentile method: linear-interpolated (NIST). p25/p50/p75 form the IQR; p10/p90 mark the tail edges.',
    ],
  };
}
