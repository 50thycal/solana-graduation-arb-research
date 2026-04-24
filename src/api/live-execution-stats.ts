/**
 * src/api/live-execution-stats.ts
 *
 * Data for the /api/live-execution-stats endpoint (published as
 * live-execution.json on bot-status). Tracks real-money execution health:
 * tx land rate, latency, Jito tip spend, measured slippage vs assumed gap
 * penalties, and circuit-breaker status.
 *
 * Claude uses this to decide whether a strategy can promote from shadow →
 * live_micro and from live_micro → live_full.
 */

import type Database from 'better-sqlite3';
import { DAILY_MAX_LOSS_SOL } from '../trading/config';
import { isKillswitchTripped, getDailyLiveNetProfitSol } from '../trading/safety';

export interface LiveExecutionStats {
  generated_at: string;
  safety: {
    killswitch_tripped: boolean;
    daily_live_net_profit_sol: number;
    daily_max_loss_sol: number;
    circuit_breaker_tripped: boolean;
  };
  by_execution_mode: Array<{
    execution_mode: string;
    strategy_id: string;
    n_total: number;
    n_closed: number;
    n_failed: number;
    tx_land_rate_pct: number | null;
    avg_tx_land_ms: number | null;
    avg_shadow_entry_slip_pct: number | null;
    avg_shadow_exit_slip_pct: number | null;
    avg_measured_entry_slip_pct: number | null;
    avg_measured_exit_slip_pct: number | null;
    paper_slgap_assumption_pct: number | null;
    paper_tpgap_assumption_pct: number | null;
    total_jito_tip_sol: number;
    avg_net_return_pct: number | null;
    total_net_profit_sol: number;
  }>;
  recent_failed_live_trades: Array<{
    tradeId: number;
    strategy_id: string;
    execution_mode: string;
    exit_reason: string;
    created_at: number;
  }>;
}

export function computeLiveExecutionStats(db: Database.Database): LiveExecutionStats {
  const killswitch = isKillswitchTripped();
  const dailyPnl = getDailyLiveNetProfitSol(db);

  const rows = db.prepare(`
    SELECT
      COALESCE(t.execution_mode, 'paper') AS execution_mode,
      COALESCE(t.strategy_id, 'default') AS strategy_id,
      COUNT(*) AS n_total,
      COUNT(CASE WHEN t.status = 'closed' THEN 1 END) AS n_closed,
      COUNT(CASE WHEN t.status = 'failed' THEN 1 END) AS n_failed,
      ROUND(AVG(t.shadow_measured_entry_slippage_pct), 3) AS avg_shadow_entry_slip_pct,
      ROUND(AVG(t.shadow_measured_exit_slippage_pct), 3) AS avg_shadow_exit_slip_pct,
      ROUND(AVG(CASE WHEN t.execution_mode IN ('live_micro','live_full')
                     AND t.status = 'closed'
                     AND t.entry_effective_price IS NOT NULL
                     AND t.entry_price_sol IS NOT NULL
                     AND t.entry_price_sol > 0
                THEN (t.entry_effective_price / t.entry_price_sol - 1) * 100 END), 3)
        AS avg_measured_entry_slip_pct,
      ROUND(AVG(t.measured_exit_slippage_pct), 3) AS avg_measured_exit_slip_pct,
      ROUND(AVG(CASE WHEN t.execution_mode IN ('live_micro','live_full') THEN t.tx_land_ms END), 0)
        AS avg_tx_land_ms,
      ROUND(SUM(CASE WHEN t.execution_mode IN ('live_micro','live_full')
                          AND t.status = 'closed'
                          AND t.entry_tx_signature IS NOT NULL THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(CASE WHEN t.execution_mode IN ('live_micro','live_full')
                                     AND t.status IN ('closed','failed') THEN 1 END), 0), 1)
        AS tx_land_rate_pct,
      ROUND(SUM(CASE WHEN t.status = 'closed' THEN COALESCE(t.jito_tip_sol, 0) ELSE 0 END), 6)
        AS total_jito_tip_sol,
      ROUND(AVG(CASE WHEN t.status = 'closed' THEN t.net_return_pct END), 2) AS avg_net_return_pct,
      ROUND(SUM(CASE WHEN t.status = 'closed' THEN t.net_profit_sol ELSE 0 END), 4)
        AS total_net_profit_sol,
      MAX(t.stop_loss_pct) AS paper_slgap_assumption_pct,
      MAX(t.take_profit_pct) AS paper_tpgap_assumption_pct
    FROM trades_v2 t
    WHERE (t.archived IS NULL OR t.archived = 0)
    GROUP BY COALESCE(t.execution_mode, 'paper'), COALESCE(t.strategy_id, 'default')
    ORDER BY 1, 2
  `).all() as any[];

  const recentFailed = db.prepare(`
    SELECT id AS tradeId, strategy_id, execution_mode, exit_reason, created_at
    FROM trades_v2
    WHERE status = 'failed'
      AND execution_mode IN ('live_micro','live_full')
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as any[];

  return {
    generated_at: new Date().toISOString(),
    safety: {
      killswitch_tripped: killswitch,
      daily_live_net_profit_sol: +dailyPnl.toFixed(4),
      daily_max_loss_sol: DAILY_MAX_LOSS_SOL,
      circuit_breaker_tripped: dailyPnl <= -DAILY_MAX_LOSS_SOL,
    },
    by_execution_mode: rows,
    recent_failed_live_trades: recentFailed,
  };
}
