/**
 * src/api/live-training-data.ts
 *
 * Pure data computation for the /live-training dashboard. Returns the data
 * object consumed by renderLiveTrainingHtml and exposed as JSON via
 * /api/live-training and the bot-status sync (live-training.json).
 *
 * Scope: ONLY live-money strategies (execution_mode in live_micro / live_full).
 * Paper and shadow rows are excluded from the primary views — shadow rows are
 * pulled in ONLY to power the matched-graduation Live-vs-Shadow comparison.
 *
 * The page is client-interactive (vanilla JS): the render function embeds the
 * raw per-trade arrays so the browser can recompute series + metrics on the
 * fly when the user switches the strategy selector or chart metric. This module
 * ALSO computes server-side aggregate metrics + comparison so that a Claude
 * session reading live-training.json off bot-status gets self-describing
 * numbers without replicating the JS.
 */

import type Database from 'better-sqlite3';
import { getStrategyConfigs } from '../db/queries';

/** Execution modes that count as "live money". */
export const LIVE_MODES = ['live_micro', 'live_full'] as const;

/**
 * Explicit live → shadow strategy mapping (maintained by hand).
 *
 * There is no field in the data linking a live strategy to the shadow
 * strategy that mirrors its configuration, and the naming is inconsistent
 * (`v25-…-live-micro` ↔ `v25-…` but `v9-…-live-micro` ↔ `v9shadow-…`), so the
 * pairing lives here. When you launch a new live strategy, add a row mapping
 * its strategy_id to the strategy_id of its shadow twin. A live strategy with
 * no entry here still shows up on the page — its Live-vs-Shadow comparison is
 * simply empty until a mapping is added.
 */
export const LIVE_SHADOW_MAP: Record<string, string> = {
  'v25-bot-excl-climbing-live-micro': 'v25-bot-excl-climbing',
  'v9-vel20-top5-live-micro': 'v9shadow-vel20-top5',
  'v9-velmono-dev-live-micro': 'v9shadow-velmono-dev',
};

/** Normalized per-trade row shared by live + shadow series. */
export interface LtTrade {
  id: number;
  strategy_id: string;
  graduation_id: number | null;
  mint: string | null;
  execution_mode: string;
  status: string; // 'closed' | 'failed' | 'open'
  entry_ts: number | null;
  exit_ts: number | null;
  held_seconds: number | null;
  net_profit_sol: number | null;
  net_return_pct: number | null;
  gross_return_pct: number | null;
  entry_slip_pct: number | null;
  exit_slip_pct: number | null;
  jito_tip_sol: number | null;
  fees_sol: number | null;
  tx_land_ms: number | null;
  exit_reason: string | null;
  trade_size_sol: number | null;
}

/** Aggregate performance metrics over a set of trades. */
export interface LtMetrics {
  n_trades: number;
  n_closed: number;
  n_failed: number;
  n_open: number;
  total_net_sol: number;
  win_rate_pct: number | null;
  n_wins: number;
  n_losses: number;
  avg_winner_sol: number | null;
  avg_loser_sol: number | null;
  avg_winner_pct: number | null;
  avg_loser_pct: number | null;
  profit_factor: number | null;
  avg_net_return_pct: number | null;
  median_net_return_pct: number | null;
  avg_holding_sec: number | null;
  largest_winner_sol: number | null;
  largest_loser_sol: number | null;
  avg_entry_slip_pct: number | null;
  avg_exit_slip_pct: number | null;
  avg_roundtrip_slip_pct: number | null;
  total_fees_sol: number;
  total_jito_tip_sol: number;
  avg_tx_land_ms: number | null;
  execution_success_rate_pct: number | null;
  sharpe_like: number | null;
  exit_reason_counts: Record<string, number>;
}

/** Matched-graduation Live-vs-Shadow comparison. */
export interface LtComparison {
  matched_n: number;
  live_total_net_sol: number;
  shadow_total_net_sol: number;
  total_net_sol_delta: number;
  live_avg_return_pct: number | null;
  shadow_avg_return_pct: number | null;
  avg_return_delta_pct: number | null;
  live_win_rate_pct: number | null;
  shadow_win_rate_pct: number | null;
  live_avg_roundtrip_slip_pct: number | null;
  shadow_avg_roundtrip_slip_pct: number | null;
  // Per-graduation pairs (chronological by live entry).
  pairs: Array<{
    graduation_id: number | null;
    mint: string | null;
    live_strategy_id: string;
    shadow_strategy_id: string;
    entry_ts: number | null;
    live_return_pct: number | null;
    shadow_return_pct: number | null;
    return_delta_pct: number | null;
    live_net_sol: number | null;
    shadow_net_sol: number | null;
    live_roundtrip_slip_pct: number | null;
    shadow_roundtrip_slip_pct: number | null;
  }>;
}

function round(v: number | null | undefined, d = 4): number | null {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

/** Round-trip slippage = entry + exit, when both present. */
function roundtripSlip(t: LtTrade): number | null {
  if (t.entry_slip_pct === null && t.exit_slip_pct === null) return null;
  return (t.entry_slip_pct ?? 0) + (t.exit_slip_pct ?? 0);
}

export function computeMetrics(trades: LtTrade[]): LtMetrics {
  const closed = trades.filter(t => t.status === 'closed');
  const failed = trades.filter(t => t.status === 'failed');
  const open = trades.filter(t => t.status === 'open');

  // A "win" is a closed trade that accumulated SOL (net_profit_sol > 0).
  const wins = closed.filter(t => (t.net_profit_sol ?? 0) > 0);
  const losses = closed.filter(t => (t.net_profit_sol ?? 0) <= 0);

  const netSols = closed.map(t => t.net_profit_sol ?? 0);
  const returns = closed.map(t => t.net_return_pct).filter((x): x is number => x !== null);
  const holds = closed.map(t => t.held_seconds).filter((x): x is number => x !== null);

  const grossWins = wins.reduce((a, t) => a + (t.net_profit_sol ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((a, t) => a + Math.min(0, t.net_profit_sol ?? 0), 0));

  const entrySlips = closed.map(t => t.entry_slip_pct).filter((x): x is number => x !== null);
  const exitSlips = closed.map(t => t.exit_slip_pct).filter((x): x is number => x !== null);
  const rtSlips = closed.map(roundtripSlip).filter((x): x is number => x !== null);
  const landMs = closed.map(t => t.tx_land_ms).filter((x): x is number => x !== null);

  const winRetPcts = wins.map(t => t.net_return_pct).filter((x): x is number => x !== null);
  const lossRetPcts = losses.map(t => t.net_return_pct).filter((x): x is number => x !== null);

  const sd = stddev(returns);
  const m = mean(returns);
  const sharpe = sd && sd > 0 && m !== null ? m / sd : null;

  const exitReasonCounts: Record<string, number> = {};
  for (const t of closed) {
    const r = t.exit_reason || 'unknown';
    exitReasonCounts[r] = (exitReasonCounts[r] || 0) + 1;
  }

  const totalFees = closed.reduce((a, t) => a + (t.fees_sol ?? 0), 0);
  const totalJito = closed.reduce((a, t) => a + (t.jito_tip_sol ?? 0), 0);

  return {
    n_trades: trades.length,
    n_closed: closed.length,
    n_failed: failed.length,
    n_open: open.length,
    total_net_sol: round(netSols.reduce((a, b) => a + b, 0))!,
    win_rate_pct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    n_wins: wins.length,
    n_losses: losses.length,
    avg_winner_sol: round(mean(wins.map(t => t.net_profit_sol ?? 0))),
    avg_loser_sol: round(mean(losses.map(t => t.net_profit_sol ?? 0))),
    avg_winner_pct: round(mean(winRetPcts), 2),
    avg_loser_pct: round(mean(lossRetPcts), 2),
    profit_factor: grossLosses > 0 ? round(grossWins / grossLosses, 2) : (grossWins > 0 ? null : 0),
    avg_net_return_pct: round(m, 2),
    median_net_return_pct: round(median(returns), 2),
    avg_holding_sec: round(mean(holds), 0),
    largest_winner_sol: round(closed.length ? Math.max(...netSols) : null),
    largest_loser_sol: round(closed.length ? Math.min(...netSols) : null),
    avg_entry_slip_pct: round(mean(entrySlips), 3),
    avg_exit_slip_pct: round(mean(exitSlips), 3),
    avg_roundtrip_slip_pct: round(mean(rtSlips), 3),
    total_fees_sol: round(totalFees, 6)!,
    total_jito_tip_sol: round(totalJito, 6)!,
    avg_tx_land_ms: round(mean(landMs), 0),
    execution_success_rate_pct: (closed.length + failed.length) > 0
      ? round((closed.length / (closed.length + failed.length)) * 100, 1)
      : null,
    sharpe_like: round(sharpe, 3),
    exit_reason_counts: exitReasonCounts,
  };
}

/**
 * Matched-graduation comparison: for each live closed trade, find its shadow
 * twin's closed trade on the SAME graduation_id (twin = LIVE_SHADOW_MAP[liveId]).
 * Only graduations both sides traded are compared — true apples-to-apples on
 * execution (same token, same entry decision, different fill path).
 */
export function computeComparison(liveTrades: LtTrade[], shadowTrades: LtTrade[]): LtComparison {
  // Index shadow closed trades by (strategy_id, graduation_id).
  const shadowIdx = new Map<string, LtTrade>();
  for (const s of shadowTrades) {
    if (s.status !== 'closed' || s.graduation_id === null) continue;
    shadowIdx.set(`${s.strategy_id}:${s.graduation_id}`, s);
  }

  const pairs: LtComparison['pairs'] = [];
  for (const live of liveTrades) {
    if (live.status !== 'closed' || live.graduation_id === null) continue;
    const shadowId = LIVE_SHADOW_MAP[live.strategy_id];
    if (!shadowId) continue;
    const twin = shadowIdx.get(`${shadowId}:${live.graduation_id}`);
    if (!twin) continue;
    const liveRt = roundtripSlip(live);
    const shadowRt = roundtripSlip(twin);
    pairs.push({
      graduation_id: live.graduation_id,
      mint: live.mint,
      live_strategy_id: live.strategy_id,
      shadow_strategy_id: shadowId,
      entry_ts: live.entry_ts,
      live_return_pct: live.net_return_pct,
      shadow_return_pct: twin.net_return_pct,
      return_delta_pct: (live.net_return_pct !== null && twin.net_return_pct !== null)
        ? round(live.net_return_pct - twin.net_return_pct, 2)
        : null,
      live_net_sol: live.net_profit_sol,
      shadow_net_sol: twin.net_profit_sol,
      live_roundtrip_slip_pct: round(liveRt, 3),
      shadow_roundtrip_slip_pct: round(shadowRt, 3),
    });
  }
  pairs.sort((a, b) => (a.entry_ts ?? 0) - (b.entry_ts ?? 0));

  const liveRets = pairs.map(p => p.live_return_pct).filter((x): x is number => x !== null);
  const shadowRets = pairs.map(p => p.shadow_return_pct).filter((x): x is number => x !== null);
  const liveWins = pairs.filter(p => (p.live_net_sol ?? 0) > 0).length;
  const shadowWins = pairs.filter(p => (p.shadow_net_sol ?? 0) > 0).length;
  const liveRt = pairs.map(p => p.live_roundtrip_slip_pct).filter((x): x is number => x !== null);
  const shadowRt = pairs.map(p => p.shadow_roundtrip_slip_pct).filter((x): x is number => x !== null);
  const liveTotal = pairs.reduce((a, p) => a + (p.live_net_sol ?? 0), 0);
  const shadowTotal = pairs.reduce((a, p) => a + (p.shadow_net_sol ?? 0), 0);

  const liveAvg = mean(liveRets);
  const shadowAvg = mean(shadowRets);

  return {
    matched_n: pairs.length,
    live_total_net_sol: round(liveTotal)!,
    shadow_total_net_sol: round(shadowTotal)!,
    total_net_sol_delta: round(liveTotal - shadowTotal)!,
    live_avg_return_pct: round(liveAvg, 2),
    shadow_avg_return_pct: round(shadowAvg, 2),
    avg_return_delta_pct: (liveAvg !== null && shadowAvg !== null) ? round(liveAvg - shadowAvg, 2) : null,
    live_win_rate_pct: pairs.length ? round((liveWins / pairs.length) * 100, 1) : null,
    shadow_win_rate_pct: pairs.length ? round((shadowWins / pairs.length) * 100, 1) : null,
    live_avg_roundtrip_slip_pct: round(mean(liveRt), 3),
    shadow_avg_roundtrip_slip_pct: round(mean(shadowRt), 3),
    pairs,
  };
}

/** Build the SELECT that normalizes live + shadow rows into LtTrade shape. */
function tradeSelect(whereSql: string): string {
  return `
    SELECT
      t.id,
      t.strategy_id,
      t.graduation_id,
      t.mint,
      COALESCE(t.execution_mode, 'paper') AS execution_mode,
      t.status,
      t.entry_timestamp AS entry_ts,
      t.exit_timestamp AS exit_ts,
      CASE WHEN t.exit_timestamp IS NOT NULL AND t.entry_timestamp IS NOT NULL
           THEN t.exit_timestamp - t.entry_timestamp END AS held_seconds,
      t.net_profit_sol,
      t.net_return_pct,
      t.gross_return_pct,
      -- Unified entry slippage: shadow uses the read-only measured value; live
      -- derives it from effective fill vs expected price (same as live-exec-stats).
      COALESCE(
        t.shadow_measured_entry_slippage_pct,
        CASE WHEN t.entry_effective_price IS NOT NULL AND t.entry_price_sol > 0
             THEN (t.entry_effective_price / t.entry_price_sol - 1) * 100 END
      ) AS entry_slip_pct,
      -- Unified exit slippage: live measured first, shadow measured fallback.
      COALESCE(t.measured_exit_slippage_pct, t.shadow_measured_exit_slippage_pct) AS exit_slip_pct,
      t.jito_tip_sol,
      t.estimated_fees_sol AS fees_sol,
      t.tx_land_ms,
      t.exit_reason,
      t.trade_size_sol
    FROM trades_v2 t
    ${whereSql}
    ORDER BY t.entry_timestamp ASC, t.id ASC`;
}

export function computeLiveTrainingData(db: Database.Database) {
  // ── Live trades: all rows in a live-money execution mode ──────────────────
  const liveTrades = db.prepare(
    tradeSelect(`WHERE COALESCE(t.execution_mode, 'paper') IN ('live_micro', 'live_full')`),
  ).all() as LtTrade[];

  // Distinct live strategy ids actually present in the data (drives selector).
  const liveStrategyIds = Array.from(new Set(liveTrades.map(t => t.strategy_id))).sort();

  // Shadow twins we need for the comparison (only those referenced by a present
  // live strategy AND defined in the explicit map).
  const neededShadowIds = Array.from(
    new Set(liveStrategyIds.map(id => LIVE_SHADOW_MAP[id]).filter((x): x is string => !!x)),
  );

  let shadowTrades: LtTrade[] = [];
  if (neededShadowIds.length) {
    const placeholders = neededShadowIds.map(() => '?').join(',');
    shadowTrades = db.prepare(
      tradeSelect(
        `WHERE COALESCE(t.execution_mode, 'paper') = 'shadow' AND t.strategy_id IN (${placeholders})`,
      ),
    ).all(...neededShadowIds) as LtTrade[];
  }

  // Labels from strategy_configs (id → label); fall back to id when absent
  // (e.g. a deleted strategy that still has historical trades).
  const labelMap = new Map<string, string>();
  for (const row of getStrategyConfigs(db)) {
    labelMap.set(row.id, row.label || row.id);
  }
  const labelFor = (id: string) => labelMap.get(id) || id;

  // Per-strategy roster for the selector.
  const strategies = liveStrategyIds.map(id => {
    const shadowId = LIVE_SHADOW_MAP[id] || null;
    const nLive = liveTrades.filter(t => t.strategy_id === id).length;
    const nShadow = shadowId ? shadowTrades.filter(t => t.strategy_id === shadowId).length : 0;
    return {
      id,
      label: labelFor(id),
      shadow_id: shadowId,
      shadow_label: shadowId ? labelFor(shadowId) : null,
      n_live: nLive,
      n_shadow: nShadow,
    };
  });

  // Server-side aggregate metrics + comparison: "all live" and per-strategy.
  const metricsAll = computeMetrics(liveTrades);
  const comparisonAll = computeComparison(liveTrades, shadowTrades);
  const metricsByStrategy: Record<string, LtMetrics> = {};
  const comparisonByStrategy: Record<string, LtComparison> = {};
  for (const id of liveStrategyIds) {
    const lt = liveTrades.filter(t => t.strategy_id === id);
    metricsByStrategy[id] = computeMetrics(lt);
    comparisonByStrategy[id] = computeComparison(lt, shadowTrades);
  }

  return {
    generated_at: new Date().toISOString(),
    live_modes: LIVE_MODES,
    mapping: LIVE_SHADOW_MAP,
    has_live_data: liveTrades.length > 0,
    strategies,
    trades: {
      live: liveTrades,
      shadow: shadowTrades,
    },
    metrics: {
      all: metricsAll,
      by_strategy: metricsByStrategy,
    },
    comparison: {
      all: comparisonAll,
      by_strategy: comparisonByStrategy,
    },
  };
}

export type LiveTrainingData = ReturnType<typeof computeLiveTrainingData>;
