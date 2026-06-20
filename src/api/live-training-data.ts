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
  // Each live strategy is paired 1:1 with a DEDICATED shadow twin running an
  // identical config at the same 0.05 SOL trade size, so the Live-vs-Shadow
  // comparison is apples-to-apples (same fill-cost model, same trade size).
  // v44 cohort — climbing-filter mirrors of v25-bot-excl-climbing, named v44
  // to avoid confusion with the v25 shadow research strategy they're based on.
  'v44-climb-live-micro': 'v44-climb-shadow',
  'v44-climb-1s-ttp10-live-micro': 'v44-climb-1s-ttp10-shadow',
  'v45-acc-gate-live-micro': 'v45-acc-gate-shadow',
  // v50 strength cohort — dedicated 0.05 SOL shadow twin, identical filters/TP/SL.
  'v50-strength-live-micro': 'v50-strength-shadow',
  // COPY-TRADE live-micro (separate copy_trades subsystem, unioned into this page so
  // it's the single live-money hub). Paired with its identical shadow twin; matched
  // on MINT (copy rows have no graduation_id) — see computeComparison's null-grad path.
  // Killed copy live strategies are removed here so they drop to "retired/off"
  // (the active gate below keys off membership in this map).
  'copy-hotlead-deep-live-micro': 'copy-hotlead-deep',
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
  tx_land_p50_ms: number | null;
  tx_land_p90_ms: number | null;
  tx_land_max_ms: number | null;
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
  // Gap attribution: how much of the live-vs-shadow return gap is the price
  // move itself (gross — i.e. exit timing/fill drift) vs execution cost.
  live_avg_gross_return_pct: number | null;
  shadow_avg_gross_return_pct: number | null;
  gross_gap_pp: number | null;     // live gross − shadow gross (timing/fill)
  cost_gap_pp: number | null;      // net gap − gross gap (slippage + fees)
  // Outlier-robustness of the aggregate SOL gap (n is usually small + fat-tailed).
  median_delta_sol: number | null; // median per-pair (live − shadow) net SOL
  delta_drop_top3_sol: number | null; // total delta minus the 3 largest |delta|
  // Live execution latency over the matched set (shadow is modeled, 0-latency).
  live_avg_tx_land_ms: number | null;
  live_p90_tx_land_ms: number | null;
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

/** Nearest-rank percentile (floor index), matching the client JS port. */
function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
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
    tx_land_p50_ms: round(pctl(landMs, 0.5), 0),
    tx_land_p90_ms: round(pctl(landMs, 0.9), 0),
    tx_land_max_ms: round(landMs.length ? Math.max(...landMs) : null, 0),
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
  // Index shadow closed trades by (strategy_id, graduation_id) for graduation-keyed
  // (T+30) pairing, and keep a per-(strategy,mint) list for copy rows that have no
  // graduation_id (matched by mint + closest entry_ts instead).
  const shadowIdx = new Map<string, LtTrade>();
  const shadowByMint = new Map<string, LtTrade[]>();
  for (const s of shadowTrades) {
    if (s.status !== 'closed') continue;
    if (s.graduation_id !== null) shadowIdx.set(`${s.strategy_id}:${s.graduation_id}`, s);
    if (s.mint) {
      const k = `${s.strategy_id}:${s.mint}`;
      (shadowByMint.get(k) ?? shadowByMint.set(k, []).get(k)!).push(s);
    }
  }
  const usedMintTwins = new Set<number>();

  const pairs: LtComparison['pairs'] = [];
  // Parallel capture for gap-attribution + latency (not exposed per-pair).
  const liveGross: number[] = [];
  const shadowGross: number[] = [];
  const liveLand: number[] = [];
  const deltas: number[] = []; // per-pair (live − shadow) net SOL
  for (const live of liveTrades) {
    if (live.status !== 'closed') continue;
    const shadowId = LIVE_SHADOW_MAP[live.strategy_id];
    if (!shadowId) continue;
    let twin: LtTrade | undefined;
    if (live.graduation_id !== null) {
      twin = shadowIdx.get(`${shadowId}:${live.graduation_id}`);
    } else if (live.mint) {
      // Copy path: match the shadow twin on the same mint, closest entry within 60s.
      const cands = shadowByMint.get(`${shadowId}:${live.mint}`) ?? [];
      let best: LtTrade | undefined; let bestDiff = 61;
      for (const c of cands) {
        if (usedMintTwins.has(c.id)) continue;
        const diff = Math.abs((c.entry_ts ?? 0) - (live.entry_ts ?? 0));
        if (diff <= 60 && diff < bestDiff) { best = c; bestDiff = diff; }
      }
      if (best) { usedMintTwins.add(best.id); twin = best; }
    }
    if (!twin) continue;
    const liveRt = roundtripSlip(live);
    const shadowRt = roundtripSlip(twin);
    if (live.gross_return_pct !== null && twin.gross_return_pct !== null) {
      liveGross.push(live.gross_return_pct);
      shadowGross.push(twin.gross_return_pct);
    }
    if (live.tx_land_ms !== null && live.tx_land_ms !== undefined) liveLand.push(live.tx_land_ms);
    // Size-match the shadow to the live trade's size before any net-SOL comparison.
    // The copy live strategy trades 0.05 SOL while its research shadow twin trades
    // 0.5 — without this the cumulative-SOL chart, totals, and deltas mix 10x sizes
    // (shadow looks 10x worse). net scales linearly with size, so scaling the shadow
    // net by live_size/shadow_size makes the comparison apples-to-apples. Return %
    // is size-independent and left untouched.
    const sizeAdj = (live.trade_size_sol && twin.trade_size_sol && twin.trade_size_sol > 0)
      ? live.trade_size_sol / twin.trade_size_sol : 1;
    const twinNet = (twin.net_profit_sol ?? 0) * sizeAdj;
    deltas.push((live.net_profit_sol ?? 0) - twinNet);
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
      shadow_net_sol: round(twinNet, 6), // size-matched to the live trade
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

  const liveGrossAvg = mean(liveGross);
  const shadowGrossAvg = mean(shadowGross);
  const grossGap = (liveGrossAvg !== null && shadowGrossAvg !== null) ? liveGrossAvg - shadowGrossAvg : null;
  const netGap = (liveAvg !== null && shadowAvg !== null) ? liveAvg - shadowAvg : null;

  // Drop-top-3-by-magnitude: total delta minus the 3 largest |delta| outliers.
  const byAbs = [...deltas].sort((a, b) => Math.abs(b) - Math.abs(a));
  const totalDelta = deltas.reduce((a, b) => a + b, 0);
  const top3 = byAbs.slice(0, 3).reduce((a, b) => a + b, 0);

  return {
    matched_n: pairs.length,
    live_total_net_sol: round(liveTotal)!,
    shadow_total_net_sol: round(shadowTotal)!,
    total_net_sol_delta: round(liveTotal - shadowTotal)!,
    live_avg_return_pct: round(liveAvg, 2),
    shadow_avg_return_pct: round(shadowAvg, 2),
    avg_return_delta_pct: netGap !== null ? round(netGap, 2) : null,
    live_win_rate_pct: pairs.length ? round((liveWins / pairs.length) * 100, 1) : null,
    shadow_win_rate_pct: pairs.length ? round((shadowWins / pairs.length) * 100, 1) : null,
    live_avg_roundtrip_slip_pct: round(mean(liveRt), 3),
    shadow_avg_roundtrip_slip_pct: round(mean(shadowRt), 3),
    live_avg_gross_return_pct: round(liveGrossAvg, 2),
    shadow_avg_gross_return_pct: round(shadowGrossAvg, 2),
    gross_gap_pp: round(grossGap, 2),
    cost_gap_pp: (netGap !== null && grossGap !== null) ? round(netGap - grossGap, 2) : null,
    median_delta_sol: round(median(deltas)),
    delta_drop_top3_sol: deltas.length ? round(totalDelta - top3) : null,
    live_avg_tx_land_ms: round(mean(liveLand), 0),
    live_p90_tx_land_ms: round(pctl(liveLand, 0.9), 0),
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

/** Same LtTrade shape, sourced from the copy_trades table (the copy-trade
 *  subsystem). Lets copy live_micro + its shadow twin appear on this page.
 *  graduation_id is null (copy isn't graduation-keyed) → comparison matches on mint. */
function copyTradeSelect(whereSql: string): string {
  return `
    SELECT
      c.id,
      c.strategy_id,
      NULL AS graduation_id,
      c.mint,
      COALESCE(c.execution_mode, 'shadow') AS execution_mode,
      c.status,
      c.entry_ts,
      c.exit_ts,
      c.hold_sec AS held_seconds,
      c.net_sol AS net_profit_sol,
      CASE WHEN c.size_sol > 0 THEN c.net_sol / c.size_sol * 100 END AS net_return_pct,
      c.gross_pct AS gross_return_pct,
      c.entry_drift_pct AS entry_slip_pct,
      NULL AS exit_slip_pct,
      c.jito_tip_sol,
      c.ata_rent_sol AS fees_sol,
      NULL AS tx_land_ms,
      c.exit_reason,
      c.size_sol AS trade_size_sol
    FROM copy_trades c
    ${whereSql}
    ORDER BY c.entry_ts ASC, c.id ASC`;
}

export function computeLiveTrainingData(db: Database.Database) {
  // ── Live trades: all rows in a live-money execution mode ──────────────────
  const liveTrades = db.prepare(
    tradeSelect(`WHERE COALESCE(t.execution_mode, 'paper') IN ('live_micro', 'live_full')`),
  ).all() as LtTrade[];

  // Union in copy-trade live-money rows (separate copy_trades table). These are
  // active by virtue of being in COPY_STRATEGIES + having live rows — strategy_configs
  // doesn't know about them, so we mark their ids active explicitly below.
  let copyLiveIds: string[] = [];
  try {
    const copyLive = db.prepare(
      copyTradeSelect(`WHERE c.execution_mode = 'live_micro' AND c.status IN ('closed', 'open')`),
    ).all() as LtTrade[];
    if (copyLive.length) {
      liveTrades.push(...copyLive);
      copyLiveIds = Array.from(new Set(copyLive.map(t => t.strategy_id)));
    }
  } catch { /* copy_trades may lack columns on old DBs — skip */ }

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
    // Copy shadow twins live in copy_trades, not trades_v2 — fetch those too.
    try {
      const copyShadow = db.prepare(
        copyTradeSelect(`WHERE c.status = 'closed' AND c.strategy_id IN (${placeholders})`),
      ).all(...neededShadowIds) as LtTrade[];
      if (copyShadow.length) shadowTrades.push(...copyShadow);
    } catch { /* skip */ }
  }

  // Labels + active-state from strategy_configs (id → label / enabled+mode).
  // "active" = currently enabled AND configured for a live execution mode.
  // Retired strategies keep historical live trades but are no longer active —
  // the page defaults to active-only and tucks the rest behind a dropdown.
  const labelMap = new Map<string, string>();
  const activeLiveIds = new Set<string>();
  for (const row of getStrategyConfigs(db)) {
    labelMap.set(row.id, row.label || row.id);
    if (row.enabled !== 1) continue;
    let mode: string | undefined;
    try { mode = JSON.parse(row.config_json)?.executionMode; } catch { /* ignore */ }
    if (mode === 'live_micro' || mode === 'live_full') activeLiveIds.add(row.id);
  }
  // Copy live strategies aren't in strategy_configs — mark active ONLY those still
  // paired in LIVE_SHADOW_MAP (i.e. the current roster). A killed copy live strategy
  // keeps its historical trades + selector chip but drops to "retired/off" instead of
  // lingering "active" on trade history alone.
  for (const id of copyLiveIds) if (LIVE_SHADOW_MAP[id]) activeLiveIds.add(id);
  const labelFor = (id: string) => labelMap.get(id) || id;

  // Per-strategy roster for the selector.
  const strategies = liveStrategyIds.map(id => {
    const shadowId = LIVE_SHADOW_MAP[id] || null;
    const nLive = liveTrades.filter(t => t.strategy_id === id).length;
    const nShadow = shadowId ? shadowTrades.filter(t => t.strategy_id === shadowId).length : 0;
    return {
      id,
      label: labelFor(id),
      active: activeLiveIds.has(id),
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
