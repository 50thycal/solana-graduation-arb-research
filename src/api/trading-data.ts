/**
 * src/api/trading-data.ts
 *
 * Pure data computation for the /trading dashboard. Returns the data object
 * consumed by renderTradingHtml and exposed as JSON via /api/trading and the
 * bot-status sync (trading.json).
 *
 * Covers: open positions, per-strategy performance, aggregate performance by
 * mode, recent trades (50), skip reasons + recent skips, top filter combos
 * (from Panel 6), and active strategy configs.
 */

import type Database from 'better-sqlite3';
import { getTradeStatsByStrategy } from '../db/queries';
import type { StrategyManager } from '../trading/strategy-manager';

export function computeTradingData(
  db: Database.Database,
  strategyManager: StrategyManager | null,
  opts?: { strategyFilter?: string; executionModeFilter?: string; topPairs?: any[] },
) {
  const strategyFilter = opts?.strategyFilter ?? '';
  // Whitelist the execution_mode filter to one of the known values — anything
  // else falls back to "no filter". Avoids accidental SQL injection via the
  // query string and keeps the URL bookmarkable to a known view.
  const KNOWN_EXEC_MODES = new Set(['paper', 'shadow', 'live_micro', 'live_full']);
  const executionModeFilter = opts?.executionModeFilter && KNOWN_EXEC_MODES.has(opts.executionModeFilter)
    ? opts.executionModeFilter
    : '';

  // Per-strategy trade aggregates across the full trades_v2 history. The
  // table includes rows for strategies that have been deleted/disabled and
  // for old execution_mode rows that don't match the strategy's current mode
  // (e.g. a strategy moved paper→shadow keeps its paper rows here forever).
  // We filter both dimensions below — see strategyStats filter further down
  // once strategies list is materialized — so the Performance by Strategy
  // panel mirrors what's currently active.
  const strategyStats = getTradeStatsByStrategy(db);

  const performanceByMode = db.prepare(`
    SELECT
      mode,
      COUNT(*) as total,
      COUNT(CASE WHEN status='closed' THEN 1 END) as closed,
      COUNT(CASE WHEN status='open' THEN 1 END) as open_count,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
      ROUND(AVG(CASE WHEN status='closed' THEN net_return_pct END), 2) as avg_net_return_pct,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('take_profit','trailing_tp') THEN 1 ELSE 0 END) as tp_exits,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('stop_loss','trailing_stop','breakeven_stop') THEN 1 ELSE 0 END) as sl_exits,
      SUM(CASE WHEN status='closed' AND exit_reason='timeout' THEN 1 ELSE 0 END) as timeout_exits,
      ROUND(SUM(CASE WHEN status='closed' THEN net_profit_sol ELSE 0 END), 4) as total_net_profit_sol
    FROM trades_v2 GROUP BY mode
  `).all() as any[];

  // Finer-grained rollout split: paper / shadow / live_micro / live_full.
  // Shadow's net_return_pct is now the measured-cost number (gross − entry slip
  // − exit slip − jito tip − tx fee, no gap penalty); avg_true_net_return_pct
  // recomputes it on the fly as a sanity check that the stored value matches.
  // For shadow rows the two columns should be identical. Null for paper rows.
  const performanceByExecutionMode = db.prepare(`
    SELECT
      COALESCE(execution_mode, 'paper') as execution_mode,
      COUNT(*) as total,
      COUNT(CASE WHEN status='closed' THEN 1 END) as closed,
      COUNT(CASE WHEN status='open' THEN 1 END) as open_count,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
      ROUND(AVG(CASE WHEN status='closed' THEN net_return_pct END), 2) as avg_net_return_pct,
      ROUND(AVG(CASE WHEN status='closed'
                       AND shadow_measured_entry_slippage_pct IS NOT NULL
                       AND shadow_measured_exit_slippage_pct IS NOT NULL
                  THEN gross_return_pct
                       - shadow_measured_entry_slippage_pct
                       - shadow_measured_exit_slippage_pct
                       - ((COALESCE(jito_tip_sol, 0.0002) + 0.00001) / NULLIF(trade_size_sol, 0)) * 100
                  END), 2) as avg_true_net_return_pct,
      COUNT(CASE WHEN status='closed'
                  AND shadow_measured_entry_slippage_pct IS NOT NULL
                  AND shadow_measured_exit_slippage_pct IS NOT NULL
                  THEN 1 END) as true_net_n,
      ROUND(AVG(CASE WHEN status='closed' THEN shadow_measured_entry_slippage_pct END), 3) as avg_shadow_entry_slip_pct,
      ROUND(AVG(CASE WHEN status='closed' THEN shadow_measured_exit_slippage_pct END), 3) as avg_shadow_exit_slip_pct,
      ROUND(AVG(CASE WHEN status='closed' THEN measured_exit_slippage_pct END), 3) as avg_measured_exit_slip_pct,
      ROUND(AVG(CASE WHEN status='closed' THEN tx_land_ms END), 0) as avg_tx_land_ms,
      ROUND(SUM(CASE WHEN status='closed' THEN jito_tip_sol ELSE 0 END), 4) as total_jito_tip_sol,
      ROUND(SUM(CASE WHEN status='closed' THEN net_profit_sol ELSE 0 END), 4) as total_net_profit_sol
    FROM trades_v2 GROUP BY COALESCE(execution_mode, 'paper')
  `).all() as any[];

  // Recent trades: optional strategy + execution_mode filter compose. Both go
  // through bound parameters; execution_mode is also whitelisted above.
  const whereClauses: string[] = [];
  const whereParams: string[] = [];
  if (strategyFilter) {
    whereClauses.push('t.strategy_id = ?');
    whereParams.push(strategyFilter);
  }
  if (executionModeFilter) {
    whereClauses.push("COALESCE(t.execution_mode, 'paper') = ?");
    whereParams.push(executionModeFilter);
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  // true_net_return_pct: on-the-fly recomputation of measured-cost return —
  // gross − entry slip − exit slip − (jito tip + tx fee)/trade_size_sol.
  // Should equal net_return_pct for shadow trades after the v1 backfill runs.
  // Null for paper or for shadow rows missing either slippage measurement.
  const tradesQuery = `SELECT t.id, t.graduation_id, t.mode, t.status, t.mint, t.strategy_id,
        COALESCE(t.execution_mode, 'paper') as execution_mode,
        t.entry_pct_from_open, t.entry_price_sol, t.entry_effective_price,
        t.exit_price_sol, t.exit_reason,
        t.gross_return_pct, t.net_return_pct, t.gap_adjusted_return_pct,
        t.jito_tip_sol, t.trade_size_sol,
        t.entry_tx_signature, t.exit_tx_signature, t.tx_land_ms,
        t.execution_failure_reason,
        CASE WHEN t.status='closed'
                  AND t.shadow_measured_entry_slippage_pct IS NOT NULL
                  AND t.shadow_measured_exit_slippage_pct IS NOT NULL
             THEN ROUND(t.gross_return_pct
                        - t.shadow_measured_entry_slippage_pct
                        - t.shadow_measured_exit_slippage_pct
                        - ((COALESCE(t.jito_tip_sol, 0.0002) + 0.00001) / NULLIF(t.trade_size_sol, 0)) * 100, 2)
             END as true_net_return_pct,
        t.take_profit_pct, t.stop_loss_pct,
        t.momentum_pct_t300, t.momentum_label,
        t.shadow_measured_entry_slippage_pct, t.shadow_measured_exit_slippage_pct,
        datetime(t.entry_timestamp, 'unixepoch') as entry_dt,
        datetime(t.exit_timestamp, 'unixepoch') as exit_dt,
        CASE WHEN t.exit_timestamp IS NOT NULL AND t.entry_timestamp IS NOT NULL
             THEN t.exit_timestamp - t.entry_timestamp END as held_seconds,
        t.filter_results_json
      FROM trades_v2 t ${whereSql}
      ORDER BY t.created_at DESC LIMIT 50`;

  const recentTrades = (db.prepare(tradesQuery).all(...whereParams) as any[]).map(t => ({
    ...t,
    filter_results: t.filter_results_json ? JSON.parse(t.filter_results_json) : null,
    filter_results_json: undefined,
  }));

  // ── Shadow slippage range ───────────────────────────────────────────────
  // Distribution of measured AMM slippage on closed shadow trades. Now includes
  // simulated jito + tx-fee overhead so the true_net_return_pct row matches the
  // canonical net_return_pct stored on the trade. Computed in JS (no sqlite
  // percentile_cont) over the raw closed-shadow population, no recency window.
  const shadowSlipRows = db.prepare(`
    SELECT
      shadow_measured_entry_slippage_pct as entry_slip,
      shadow_measured_exit_slippage_pct as exit_slip,
      gross_return_pct,
      ((COALESCE(jito_tip_sol, 0.0002) + 0.00001) / NULLIF(trade_size_sol, 0)) * 100 as overhead_pct,
      gross_return_pct
        - shadow_measured_entry_slippage_pct
        - shadow_measured_exit_slippage_pct
        - ((COALESCE(jito_tip_sol, 0.0002) + 0.00001) / NULLIF(trade_size_sol, 0)) * 100 as true_net_return_pct
    FROM trades_v2
    WHERE status='closed'
      AND COALESCE(execution_mode, 'paper') = 'shadow'
      AND shadow_measured_entry_slippage_pct IS NOT NULL
      AND shadow_measured_exit_slippage_pct IS NOT NULL
      AND gross_return_pct IS NOT NULL
      AND trade_size_sol > 0
  `).all() as Array<{ entry_slip: number; exit_slip: number; gross_return_pct: number; overhead_pct: number; true_net_return_pct: number }>;

  function summarize(values: number[]) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      n: sorted.length,
      min: +sorted[0].toFixed(3),
      p10: +pick(0.10).toFixed(3),
      p50: +pick(0.50).toFixed(3),
      p90: +pick(0.90).toFixed(3),
      max: +sorted[sorted.length - 1].toFixed(3),
      mean: +(sum / sorted.length).toFixed(3),
    };
  }

  const entrySlips = shadowSlipRows.map(r => r.entry_slip);
  const exitSlips = shadowSlipRows.map(r => r.exit_slip);
  const roundTripSlips = shadowSlipRows.map(r => r.entry_slip + r.exit_slip);
  const overheadPcts = shadowSlipRows.map(r => r.overhead_pct);
  const trueNetReturns = shadowSlipRows.map(r => r.true_net_return_pct);

  const shadowSlippageRange = {
    n_trades: shadowSlipRows.length,
    entry_slippage_pct: summarize(entrySlips),
    exit_slippage_pct: summarize(exitSlips),
    round_trip_slippage_pct: summarize(roundTripSlips),
    sim_overhead_pct: summarize(overheadPcts),
    true_net_return_pct: summarize(trueNetReturns),
  };

  const smStats = strategyManager ? strategyManager.getStats() : null;
  const openPositions = smStats?.activePositionDetails ?? [];
  const strategies = strategyManager ? strategyManager.getStrategies() : [];

  // Filter strategyStats to the currently-active (id, execution_mode) tuples.
  // 2026-05-14: previously the Performance by Strategy panel showed every
  // historical row including disabled-cohort strategies and stale execution-
  // mode rows (e.g. a strategy moved paper→shadow kept its paper row showing).
  // The panel now mirrors the enabled set 1:1.
  const enabledTupleSet = new Set<string>();
  for (const s of strategies as Array<{ id: string; enabled: boolean; params: any }>) {
    if (!s.enabled) continue;
    const mode = s.params?.executionMode ?? 'paper';
    enabledTupleSet.add(`${s.id}:${mode}`);
  }
  const strategyStatsActive = (strategyStats as Array<any>).filter(
    (row) => enabledTupleSet.has(`${row.strategy_id}:${row.execution_mode ?? 'paper'}`),
  );

  const skipReasons = db.prepare(`
    SELECT skip_reason, COUNT(*) as count
    FROM trade_skips GROUP BY skip_reason ORDER BY count DESC
  `).all() as any[];

  // Recent skips: optional strategy filter so the panel mirrors what Recent
  // Trades does — clicking a low-volume strategy on /trading shows that
  // strategy's actual last 20 skips instead of a slice of the global 50.
  const skipsWhereClauses: string[] = [];
  const skipsWhereParams: string[] = [];
  if (strategyFilter) {
    skipsWhereClauses.push('ts.strategy_id = ?');
    skipsWhereParams.push(strategyFilter);
  }
  const skipsWhereSql = skipsWhereClauses.length ? `WHERE ${skipsWhereClauses.join(' AND ')}` : '';
  const recentSkips = db.prepare(`
    SELECT ts.graduation_id, ts.skip_reason, ts.skip_value, ts.pct_t30, ts.strategy_id,
      datetime(ts.created_at, 'unixepoch') as created_dt, g.mint
    FROM trade_skips ts JOIN graduations g ON g.id = ts.graduation_id
    ${skipsWhereSql}
    ORDER BY ts.created_at DESC LIMIT 50
  `).all(...skipsWhereParams) as any[];

  const config = strategyManager ? strategyManager.getConfig() : null;

  return {
    generated_at: new Date().toISOString(),
    trading_enabled: config?.enabled ?? false,
    global_mode: config?.mode ?? 'paper',
    strategies,
    selected_strategy: strategyFilter,
    selected_execution_mode: executionModeFilter,
    config: config ? {
      mode: config.mode,
      trade_size_sol: config.tradeSizeSol,
      take_profit_pct: config.takeProfitPct,
      stop_loss_pct: config.stopLossPct,
      max_hold_seconds: config.maxHoldSeconds,
      entry_gate: `+${config.entryGateMinPctT30}% to +${config.entryGateMaxPctT30}%`,
      max_concurrent_positions: config.maxConcurrentPositions,
      filters: config.filters,
    } : null,
    open_positions: openPositions,
    performance_summary: performanceByMode,
    performance_by_execution_mode: performanceByExecutionMode,
    shadow_slippage_range: shadowSlippageRange,
    strategy_stats: strategyStatsActive,
    recent_trades: recentTrades,
    skip_reason_counts: skipReasons,
    recent_skips: recentSkips,
    top_pairs: opts?.topPairs ?? [],
  };
}

export type TradingData = ReturnType<typeof computeTradingData>;
