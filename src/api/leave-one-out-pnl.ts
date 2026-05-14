import type Database from 'better-sqlite3';

/**
 * Leave-one-out P&L panel — outlier robustness for per-strategy SOL accumulation.
 *
 * The bot's purpose is accumulating SOL. Median / mean alone hide whether a
 * strategy's apparent edge is driven by one or two lottery-ticket trades. This
 * panel reports total net SOL with the top 1 and top 3 winners stripped, so a
 * "real edge" strategy stays positive after the strip and a "lottery" strategy
 * collapses.
 *
 * Companion to /api/strategy-percentiles (return-distribution view) and the
 * daily-report `promotion_readiness_top5` block, which consumes this output to
 * rank strategies against the SOL-accumulation bar (CLAUDE.md "How to evaluate
 * a candidate").
 */

export interface LeaveOneOutRow {
  strategy_id: string;
  label: string;
  enabled: boolean;
  execution_mode: string;
  n_trades: number;
  total_net_sol: number;
  total_net_sol_drop_top1: number;
  total_net_sol_drop_top3: number;
  /** (top1_net_sol / total_net_sol) * 100, capped at ±999 when total ~0. */
  top1_contribution_pct: number | null;
  top3_contribution_pct: number | null;
  /** Mint of the single largest net_profit_sol trade — drill-down anchor. */
  top1_mint: string | null;
  /** Mints of the three largest net_profit_sol trades, desc. */
  top3_mints: string[];
  mean_net_pct: number | null;
  /** Mean after dropping top/bottom 5% by net_return_pct (NIST-interpolated cuts). */
  trimmed_mean_net_pct: number | null;
  win_rate_pct: number | null;
  /** (total_net_sol / max(days_active, 1)) * 30. Projects to monthly run rate. */
  monthly_run_rate_sol: number;
  /** First-to-last exit_timestamp span in days (floored at 1). */
  days_active: number;
  /** UTC ISO of first / last closed trade in this bucket. */
  first_exit_ts: number | null;
  last_exit_ts: number | null;
}

export interface LeaveOneOutData {
  generated_at: string;
  /** Bar referenced by promotion_readiness_top5 — kept here so the panel is self-describing. */
  promotion_bar: {
    min_n_trades: number;
    min_total_net_sol: number;
    min_monthly_run_rate_sol: number;
    drop_top3_must_be_positive: true;
  };
  active_strategy_count: number;
  total_closed_trades: number;
  rows: LeaveOneOutRow[];
  notes: string[];
}

interface TradeRow {
  strategy_id: string;
  execution_mode: string;
  mint: string | null;
  net_return_pct: number | null;
  net_profit_sol: number | null;
  exit_timestamp: number | null;
}

/** Linear-interpolated percentile (NIST method). Mirrors strategy-percentiles.ts. */
function pickPercentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** Mean after stripping values outside [p5, p95]. Returns null when n < 20 (cuts unreliable). */
function trimmedMean(values: number[]): number | null {
  if (values.length < 20) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = pickPercentile(sorted, 0.05);
  const hi = pickPercentile(sorted, 0.95);
  if (lo == null || hi == null) return null;
  const kept = values.filter(v => v >= lo && v <= hi);
  if (kept.length === 0) return null;
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

function safeContributionPct(part: number, whole: number): number | null {
  if (Math.abs(whole) < 1e-9) return null;
  const pct = (part / whole) * 100;
  if (pct > 999) return 999;
  if (pct < -999) return -999;
  return +pct.toFixed(2);
}

/**
 * Compute leave-one-out P&L using only trades with `exit_timestamp <= asOfSec`.
 * Used by the backfill script to reconstruct per-day historical snapshots so
 * the dashboard's time-series charts have meaningful history immediately
 * (rather than waiting for new snapshots to accumulate going forward).
 *
 * Default behavior (`asOfSec` undefined) is identical to the original call.
 */
export function computeLeaveOneOutPnl(db: Database.Database, asOfSec?: number): LeaveOneOutData {
  const generated_at = new Date().toISOString();

  // Pull every closed trade for any strategy that has either:
  //   (a) currently enabled in strategy_configs, OR
  //   (b) has at least one closed trade (so recently-killed strategies still
  //       surface for postmortem). The `enabled` flag on each row tells the
  //       caller which bucket it's in.
  const configs = db.prepare(`
    SELECT id, label, enabled FROM strategy_configs
  `).all() as Array<{ id: string; label: string; enabled: number }>;
  const labelById = new Map(configs.map(c => [c.id, c.label]));
  const enabledById = new Map(configs.map(c => [c.id, c.enabled === 1]));

  // asOfSec cap shifts this from "lifetime now" to "lifetime as of <date>" so
  // the backfill produces historically accurate readiness scores.
  const asOfClause = asOfSec != null ? 'AND exit_timestamp <= ?' : '';
  const stmt = db.prepare(`
    SELECT
      strategy_id,
      COALESCE(execution_mode, 'paper') AS execution_mode,
      mint,
      net_return_pct,
      net_profit_sol,
      exit_timestamp
    FROM trades_v2
    WHERE status = 'closed'
      AND strategy_id IS NOT NULL
      AND (archived IS NULL OR archived = 0)
      ${asOfClause}
  `);
  const trades = (asOfSec != null
    ? stmt.all(asOfSec)
    : stmt.all()) as TradeRow[];

  // Bucket per (strategy_id, execution_mode). Same convention as
  // computeStrategyPercentiles + getTradeStatsByStrategy.
  const buckets = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = `${t.strategy_id}|${t.execution_mode}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }

  const rows: LeaveOneOutRow[] = [];
  let totalClosed = 0;

  for (const [key, group] of buckets) {
    const [strategyId, executionMode] = key.split('|');
    totalClosed += group.length;

    // Sort once descending by net_profit_sol so top1/top3 are O(1).
    const byProfitDesc = [...group].sort(
      (a, b) => (b.net_profit_sol ?? -Infinity) - (a.net_profit_sol ?? -Infinity),
    );
    const profitSum = group.reduce((s, t) => s + (t.net_profit_sol ?? 0), 0);
    const top1Profit = byProfitDesc[0]?.net_profit_sol ?? 0;
    const top3Profit = byProfitDesc.slice(0, 3).reduce((s, t) => s + (t.net_profit_sol ?? 0), 0);
    const dropTop1 = profitSum - top1Profit;
    const dropTop3 = profitSum - top3Profit;

    const netReturns = group
      .map(t => t.net_return_pct)
      .filter((v): v is number => v != null);
    const meanNet = netReturns.length > 0
      ? netReturns.reduce((s, v) => s + v, 0) / netReturns.length
      : null;
    const trimmed = trimmedMean(netReturns);
    const winners = netReturns.filter(v => v > 0).length;
    const winRatePct = netReturns.length > 0
      ? +((winners / netReturns.length) * 100).toFixed(1)
      : null;

    const exitTs = group.map(t => t.exit_timestamp).filter((v): v is number => v != null);
    const firstTs = exitTs.length > 0 ? Math.min(...exitTs) : null;
    const lastTs = exitTs.length > 0 ? Math.max(...exitTs) : null;
    const spanSec = firstTs != null && lastTs != null ? lastTs - firstTs : 0;
    const daysActive = Math.max(spanSec / 86400, 1);
    const monthlyRunRate = (profitSum / daysActive) * 30;

    rows.push({
      strategy_id: strategyId,
      label: labelById.get(strategyId) ?? strategyId,
      enabled: enabledById.get(strategyId) ?? false,
      execution_mode: executionMode,
      n_trades: group.length,
      total_net_sol: +profitSum.toFixed(4),
      total_net_sol_drop_top1: +dropTop1.toFixed(4),
      total_net_sol_drop_top3: +dropTop3.toFixed(4),
      top1_contribution_pct: safeContributionPct(top1Profit, profitSum),
      top3_contribution_pct: safeContributionPct(top3Profit, profitSum),
      top1_mint: byProfitDesc[0]?.mint ?? null,
      top3_mints: byProfitDesc.slice(0, 3).map(t => t.mint).filter((m): m is string => m != null),
      mean_net_pct: meanNet != null ? +meanNet.toFixed(2) : null,
      trimmed_mean_net_pct: trimmed != null ? +trimmed.toFixed(2) : null,
      win_rate_pct: winRatePct,
      monthly_run_rate_sol: +monthlyRunRate.toFixed(4),
      days_active: +daysActive.toFixed(2),
      first_exit_ts: firstTs,
      last_exit_ts: lastTs,
    });
  }

  // Sort: enabled strategies first, then by monthly_run_rate_sol desc — surfaces
  // closest-to-bar at the top. Disabled rows fall through for postmortem context.
  rows.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return b.monthly_run_rate_sol - a.monthly_run_rate_sol;
  });

  const enabledCount = rows.filter(r => r.enabled).length;

  return {
    generated_at,
    promotion_bar: {
      min_n_trades: 100,
      min_total_net_sol: 0.5,
      min_monthly_run_rate_sol: 3.75,
      drop_top3_must_be_positive: true,
    },
    active_strategy_count: enabledCount,
    total_closed_trades: totalClosed,
    rows,
    notes: [
      'Outlier-robustness panel: total_net_sol_drop_top1 / drop_top3 strip the largest 1 and 3 winners by net_profit_sol.',
      'A strategy whose drop_top3 is <= 0 has no real edge — the apparent profit was 1-3 trades of luck.',
      'monthly_run_rate_sol = (total_net_sol / max(days_active, 1)) * 30. Promotion bar is >= 3.75 SOL/month (~$300/month at current SOL).',
      'trimmed_mean_net_pct strips top/bottom 5% by net_return_pct; null when n < 20 (cuts unreliable on small samples).',
      'Per-strategy buckets are split by execution_mode (paper / shadow / live) — same convention as /api/strategy-percentiles.',
      'Rows include disabled strategies that have closed trades, flagged by enabled=false, for postmortem context.',
    ],
  };
}
