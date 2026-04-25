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
  // Use this panel to compare measured vs assumed slippage during the rollout.
  const performanceByExecutionMode = db.prepare(`
    SELECT
      COALESCE(execution_mode, 'paper') as execution_mode,
      COUNT(*) as total,
      COUNT(CASE WHEN status='closed' THEN 1 END) as closed,
      COUNT(CASE WHEN status='open' THEN 1 END) as open_count,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
      ROUND(AVG(CASE WHEN status='closed' THEN net_return_pct END), 2) as avg_net_return_pct,
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
  const tradesQuery = `SELECT t.id, t.graduation_id, t.mode, t.status, t.mint, t.strategy_id,
        COALESCE(t.execution_mode, 'paper') as execution_mode,
        t.entry_pct_from_open, t.entry_price_sol, t.entry_effective_price,
        t.exit_price_sol, t.exit_reason, t.net_return_pct, t.gap_adjusted_return_pct,
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

  const smStats = strategyManager ? strategyManager.getStats() : null;
  const openPositions = smStats?.activePositionDetails ?? [];
  const strategies = strategyManager ? strategyManager.getStrategies() : [];

  const skipReasons = db.prepare(`
    SELECT skip_reason, COUNT(*) as count
    FROM trade_skips GROUP BY skip_reason ORDER BY count DESC
  `).all() as any[];

  const recentSkips = db.prepare(`
    SELECT ts.graduation_id, ts.skip_reason, ts.skip_value, ts.pct_t30, ts.strategy_id,
      datetime(ts.created_at, 'unixepoch') as created_dt, g.mint
    FROM trade_skips ts JOIN graduations g ON g.id = ts.graduation_id
    ORDER BY ts.created_at DESC LIMIT 50
  `).all() as any[];

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
    strategy_stats: strategyStats,
    recent_trades: recentTrades,
    skip_reason_counts: skipReasons,
    recent_skips: recentSkips,
    top_pairs: opts?.topPairs ?? [],
  };
}

export type TradingData = ReturnType<typeof computeTradingData>;
