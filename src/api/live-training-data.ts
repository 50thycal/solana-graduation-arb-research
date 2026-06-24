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
  // it's the single live-money hub). Paired with its DEDICATED pair shadow — a 0.05-SOL
  // twin spawned 1:1 with each live entry (shared copy_event_id), so the comparison is
  // exact. Killed copy live strategies are removed here so they drop to "retired/off"
  // (the active gate below keys off membership in this map).
  // KILLED 2026-06-23: copy-hotlead-deep-live-micro — was wired to the ORIGINAL research
  // strategy (copy-hotlead-deep), not a dedicated twin; removed → retired/off.
  'copy-hotlead-hold30m-live-micro': 'copy-hotlead-hold30m-pair-shadow',
};

// Trend benchmark only: the ORIGINAL research strategy each live strategy is derived
// from (0.5 SOL, longer-running). NOT the execution twin — used to confirm the live +
// pair shadow track the same TREND as the proven original, never for gating or 1:1
// matching. live → original-strategy-id.
export const LIVE_ORIGINAL_MAP: Record<string, string> = {
  'copy-hotlead-hold30m-live-micro': 'copy-hotlead-hold30m',
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
  // Diagnostic fields for entry-gap vs exit-execution classification: the effective
  // entry fill, the high-water mark reached during the hold, and the TP trigger
  // price. high_price is null for trades_v2 (no stored HWM) — only the copy_trades
  // path records it, which is the path that matters for the copy live↔shadow gap.
  entry_price: number | null;
  high_price: number | null;
  tp_price: number | null;
  // Shared lead-buy event id (copy_trades only). One value per onLeadBuy() call,
  // written to a live row and its shadow twin alike — the deterministic 1:1 join
  // key for copy pairing (copy rows have no graduation_id). Null for graduation
  // strategies and pre-migration copy rows; matcher falls back to mint+time then.
  copy_event_id: string | null;
  // Which path the live entry swap landed through: 'jito' (bundle) or 'rpc' (fallback).
  // copy live_micro only; null elsewhere. Pairs with tx_land_ms for the latency post-mortem.
  entry_land_path: string | null;
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
  // Longest consecutive win / loss streaks per side over the matched pairs
  // (time-ordered; a win is net_sol > 0). Compared live-vs-shadow on the page.
  live_longest_win_streak: number;
  live_longest_loss_streak: number;
  shadow_longest_win_streak: number;
  shadow_longest_loss_streak: number;
  // Divergence tally: matched pairs where live materially differs from its shadow
  // twin (|return_delta_pct| >= DIVERGENCE_PP). live_worse = live underperformed.
  divergence_pp_threshold: number;
  divergence_count: number;
  divergence_live_worse: number;
  divergence_live_better: number;
  // Tally of pairs by divergence_class (see classifyDivergence) — the at-a-glance
  // answer to "are the live underperformers entry-gap or exit-execution failures".
  divergence_class_counts: Record<string, number>;
  // Strategy age + run-rate projection + original-strategy benchmark + an
  // "adjusted" live that strips the worst execution blowups. Run rates use the
  // SAME basis as "The Analyst" on /live-training: FULL-strategy net ÷ days since
  // first trade (floored at 7) × period, so the panel's Live SOL/mo MATCHES the
  // Analyst's headline number instead of computing a competing figure. Live +
  // parent are normalized to LIVE trade size so they compare apples-to-apples.
  run_rate: {
    basis: string;
    live_trade_size_sol: number | null;
    parent_trade_size_sol: number | null;
    // FULL live strategy (all closed live trades, NOT just matched pairs).
    live: {
      first_entry_ts: number | null; age_days: number | null; run_days: number;
      n: number; total_net_sol: number | null; net_per_trade: number | null;
      weekly_sol: number | null; monthly_sol: number | null;
    };
    // Parent = the FULL standalone ORIGINAL research strategy (LIVE_ORIGINAL_MAP, e.g.
    // copy-hotlead-hold30m) — the long-running proven trend the live should track,
    // size-normalized to live. NOT the pair shadow. net_per_trade_live_size is the
    // run-length-INDEPENDENT trend metric (avg net per trade @ live size) — unlike
    // monthly_sol it needs no time extrapolation, so it's apples-to-apples at any age.
    parent: {
      strategy_id: string | null; n: number; age_days: number | null; run_days: number;
      total_net_sol_live_size: number | null; net_per_trade_live_size: number | null;
      weekly_sol: number | null; monthly_sol: number | null;
    };
    // Pair shadow = the dedicated same-age modeled twin (LIVE_SHADOW_MAP). Same window
    // as live → the "ideal execution" run-rate the live is measured against. The 3-way
    // (live / pair / parent) is the apples-to-apples trend check: are the young pair +
    // live tracking the long-running original's per-trade edge?
    pair: {
      strategy_id: string | null; n: number; age_days: number | null; run_days: number;
      total_net_sol_live_size: number | null; net_per_trade_live_size: number | null;
      weekly_sol: number | null; monthly_sol: number | null;
    };
    // FULL live MINUS the matched pairs where live underperformed its shadow twin
    // by >= divergence_pp_threshold (the rent/phantom-class execution blowups) —
    // what live earns once its worst execution misses are stripped.
    adjusted_live: {
      divergence_pp_threshold: number; excluded_n: number;
      total_net_sol: number | null; weekly_sol: number | null; monthly_sol: number | null;
    };
  };
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
    // ── Divergence diagnostics (entry-gap vs exit-execution) ──
    live_entry_price: number | null;
    shadow_entry_price: number | null;
    entry_gap_pct: number | null;       // (live_entry/shadow_entry − 1)·100; >0 = live filled HIGHER
    live_high_price: number | null;     // HWM during the hold (copy path only; null for trades_v2)
    live_tp_price: number | null;       // TP trigger price
    live_high_pct_of_tp: number | null; // live_high/live_tp·100; ≥100 = price reached live's TP
    live_reached_tp: boolean | null;    // live_high ≥ live_tp (null when HWM unknown)
    live_exit_reason: string | null;
    shadow_exit_reason: string | null;
    divergence_class: string | null;    // 'exit_execution' | 'entry_gap' | 'small_move' | 'aligned' | 'live_outperform' | 'unclassified'
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

/** Classify WHY a matched pair diverged, so a session can tell entry-gap from
 *  exit-execution failure without pulling the DB. Only material live
 *  UNDERperformance (return_delta ≤ −15pp) is diagnosed; the rest is labeled plainly.
 *   - exit_execution: the price reached live's TP but live did NOT exit at TP (rode
 *     to a stop / timeout). The 9fMPboAS class — the fast-retry + hot-poll target.
 *   - entry_gap: live never reached its TP but the shadow twin DID hit its TP, so
 *     live's higher fill (its TP sits above where the token topped) is the cause.
 *   - small_move: neither side reached TP — the move just wasn't big enough (not a bug).
 *   - unclassified: live's HWM is unknown (trades_v2 has no stored high_price).
 *  Decisive input is liveReachedTp (= live_high ≥ live_tp), available on the copy path. */
function classifyDivergence(args: {
  returnDeltaPct: number | null;
  liveReachedTp: boolean | null;
  liveExitReason: string | null;
  shadowExitReason: string | null;
}): string | null {
  const { returnDeltaPct, liveReachedTp, liveExitReason, shadowExitReason } = args;
  if (returnDeltaPct === null) return null;
  if (returnDeltaPct >= 15) return 'live_outperform';
  if (returnDeltaPct > -15) return 'aligned';
  // Live materially worse than the shadow twin — diagnose the cause.
  if (liveReachedTp === true) return liveExitReason === 'take_profit' ? 'aligned' : 'exit_execution';
  if (liveReachedTp === false) return shadowExitReason === 'take_profit' ? 'entry_gap' : 'small_move';
  return 'unclassified'; // HWM unknown (trades_v2) — can't decide
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
  const shadowByEvent = new Map<string, LtTrade>(); // (shadowId:copy_event_id) → twin
  for (const s of shadowTrades) {
    if (s.status !== 'closed') continue;
    if (s.graduation_id !== null) shadowIdx.set(`${s.strategy_id}:${s.graduation_id}`, s);
    if (s.copy_event_id) shadowByEvent.set(`${s.strategy_id}:${s.copy_event_id}`, s);
    if (s.mint) {
      const k = `${s.strategy_id}:${s.mint}`;
      (shadowByMint.get(k) ?? shadowByMint.set(k, []).get(k)!).push(s);
    }
  }
  const usedMintTwins = new Set<number>();
  // Mint+time fallback for copy rows that predate the copy_event_id join key.
  // Genuine same-event twins enter within ~5s of each other (both delay 5s after
  // the lead buy, then enter) — 82% of real pairs land inside 0-5s. So this window
  // is deliberately TIGHT: it approximates "same lead-buy event" for legacy rows.
  // Do NOT widen it — entries that land minutes/hours apart on the same mint are
  // NOT delayed twins, they're independent re-entries (the shadow was still holding
  // from an earlier entry, so it skipped that lead-buy via already_open; live had
  // exited and re-entered). Pairing those would compare unrelated trades.
  const COPY_MINT_MATCH_WINDOW_SEC = 60;

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
    } else if (live.copy_event_id) {
      // Copy path, deterministic: both rows from the same onLeadBuy() carry the same
      // copy_event_id → exact 1:1, regardless of fill-timing offset or re-entries.
      const exact = shadowByEvent.get(`${shadowId}:${live.copy_event_id}`);
      if (exact && !usedMintTwins.has(exact.id)) { usedMintTwins.add(exact.id); twin = exact; }
    }
    if (!twin && live.graduation_id === null && live.mint && !live.copy_event_id) {
      // Fallback for pre-migration copy rows ONLY (no copy_event_id): same mint,
      // closest entry within the widened window. A live row that HAS an event id is
      // new-era — it pairs by event id above or is genuinely unpairable (shadow
      // skipped that event); never let it mint-grab an unrelated twin.
      const cands = shadowByMint.get(`${shadowId}:${live.mint}`) ?? [];
      let best: LtTrade | undefined; let bestDiff = COPY_MINT_MATCH_WINDOW_SEC + 1;
      for (const c of cands) {
        if (usedMintTwins.has(c.id)) continue;
        if (c.copy_event_id) continue; // event-keyed twins are paired above, not here
        const diff = Math.abs((c.entry_ts ?? 0) - (live.entry_ts ?? 0));
        if (diff <= COPY_MINT_MATCH_WINDOW_SEC && diff < bestDiff) { best = c; bestDiff = diff; }
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
    // ── Divergence diagnostics ──
    // Entry gap: how much higher (or lower) the live REAL fill landed vs the
    // shadow's modeled snapshot entry. Reached-TP: did the price ever hit live's
    // TP during the hold (HWM ≥ TP)? Together they separate an entry-fill miss
    // from an exit-execution miss. Prices are per-token, so size-independent.
    const liveEntry = live.entry_price;
    const shadowEntry = twin.entry_price;
    const entryGapPct = (liveEntry != null && shadowEntry != null && shadowEntry > 0)
      ? (liveEntry / shadowEntry - 1) * 100 : null;
    const liveHigh = live.high_price;
    const liveTp = live.tp_price;
    const liveHighPctOfTp = (liveHigh != null && liveTp != null && liveTp > 0)
      ? (liveHigh / liveTp) * 100 : null;
    const liveReachedTp = (liveHigh != null && liveTp != null) ? liveHigh >= liveTp : null;
    const returnDeltaPct = (live.net_return_pct !== null && twin.net_return_pct !== null)
      ? round(live.net_return_pct - twin.net_return_pct, 2) : null;
    pairs.push({
      graduation_id: live.graduation_id,
      mint: live.mint,
      live_strategy_id: live.strategy_id,
      shadow_strategy_id: shadowId,
      entry_ts: live.entry_ts,
      live_return_pct: live.net_return_pct,
      shadow_return_pct: twin.net_return_pct,
      return_delta_pct: returnDeltaPct,
      live_net_sol: live.net_profit_sol,
      shadow_net_sol: round(twinNet, 6), // size-matched to the live trade
      live_roundtrip_slip_pct: round(liveRt, 3),
      shadow_roundtrip_slip_pct: round(shadowRt, 3),
      live_entry_price: liveEntry,
      shadow_entry_price: shadowEntry,
      entry_gap_pct: round(entryGapPct, 2),
      live_high_price: liveHigh,
      live_tp_price: liveTp,
      live_high_pct_of_tp: round(liveHighPctOfTp, 1),
      live_reached_tp: liveReachedTp,
      live_exit_reason: live.exit_reason,
      shadow_exit_reason: twin.exit_reason,
      divergence_class: classifyDivergence({
        returnDeltaPct, liveReachedTp,
        liveExitReason: live.exit_reason, shadowExitReason: twin.exit_reason,
      }),
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

  // Tally pairs by divergence_class for the at-a-glance entry-gap-vs-exit breakdown.
  const divergenceClassCounts: Record<string, number> = {};
  for (const p of pairs) {
    if (p.divergence_class) divergenceClassCounts[p.divergence_class] = (divergenceClassCounts[p.divergence_class] ?? 0) + 1;
  }

  // Longest consecutive win / loss streaks per side (pairs are time-ordered above).
  const streaks = (net: (p: typeof pairs[number]) => number | null) => {
    let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
    for (const p of pairs) {
      if ((net(p) ?? 0) > 0) { curWin += 1; curLoss = 0; if (curWin > maxWin) maxWin = curWin; }
      else { curLoss += 1; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }
    }
    return { win: maxWin, loss: maxLoss };
  };
  const liveStreak = streaks(p => p.live_net_sol);
  const shadowStreak = streaks(p => p.shadow_net_sol);

  // Divergence tally: pairs where live materially differs from its shadow twin.
  const DIVERGENCE_PP = 15;
  let divLiveWorse = 0, divLiveBetter = 0;
  for (const p of pairs) {
    const d = p.return_delta_pct;
    if (d === null) continue;
    if (d <= -DIVERGENCE_PP) divLiveWorse += 1;
    else if (d >= DIVERGENCE_PP) divLiveBetter += 1;
  }

  // ── Strategy age + run-rate projection + parent benchmark + adjusted live ──
  // SAME basis as "The Analyst" headline (anAssess): FULL-strategy net ÷ days
  // since first trade (floored at 7) × period, normalized to live size. This is
  // deliberately NOT the matched-pairs subset — the matched numbers are for the
  // execution-gap rows only. Computing run rate on the full strategy makes the
  // panel's Live SOL/mo equal the Analyst / Metrics-Summary figure instead of a
  // competing one (the 2026-06-23 "top doesn't match bottom" mismatch).
  const firstTsOf = (tss: Array<number | null | undefined>): number | null => {
    const xs = tss.filter((t): t is number => t != null && isFinite(t));
    return xs.length ? Math.min(...xs) : null;
  };
  const ageDaysOf = (firstTs: number | null): number | null =>
    firstTs == null ? null : round((Date.now() / 1000 - firstTs) / 86_400, 1);
  // Denominator: calendar days since the first trade, floored at 7 — IDENTICAL to
  // The Analyst's `days = max((now-firstTs)/86400, 7)`.
  const runDaysOf = (firstTs: number | null): number =>
    firstTs == null ? 7 : Math.max((Date.now() / 1000 - firstTs) / 86_400, 7);
  const perPeriod = (total: number, days: number, mult: number): number | null =>
    days > 0 ? round((total / days) * mult, 4) : null;

  const liveClosed = liveTrades.filter(t => t.status === 'closed');
  const liveSize = liveClosed.find(t => (t.trade_size_sol ?? 0) > 0)?.trade_size_sol ?? null;
  const liveFirstTs = firstTsOf(liveClosed.map(t => t.entry_ts));
  const liveRunDays = runDaysOf(liveFirstTs);
  // FULL live net — sum over ALL closed live trades (matches jsComputeMetrics /
  // The Analyst's m.total_net_sol), NOT the matched-pairs subset.
  const liveNetFull = liveClosed.reduce((a, t) => a + (t.net_profit_sol ?? 0), 0);

  // Parent = the ORIGINAL research strategy (LIVE_ORIGINAL_MAP), the proven 0.5-SOL
  // strategy the live is derived from — a TREND benchmark, size-normalized to live.
  // (The execution twin for the 1:1 panel is the pair shadow via LIVE_SHADOW_MAP; this
  // parent is deliberately the original so we can see live + pair shadow track its trend.)
  const mappedOriginalIds = new Set(
    liveClosed.map(t => LIVE_ORIGINAL_MAP[t.strategy_id]).filter((x): x is string => !!x),
  );
  const parentTrades = shadowTrades.filter(t => t.status === 'closed' && mappedOriginalIds.has(t.strategy_id));
  const parentNativeTotal = parentTrades.reduce((a, t) => a + (t.net_profit_sol ?? 0), 0);
  const parentSize = parentTrades.find(t => (t.trade_size_sol ?? 0) > 0)?.trade_size_sol ?? null;
  const sizeNorm = (liveSize && parentSize && parentSize > 0) ? liveSize / parentSize : 1;
  const parentTotalLiveSize = parentTrades.length ? round(parentNativeTotal * sizeNorm) : null;
  const parentFirstTs = firstTsOf(parentTrades.map(t => t.entry_ts));
  const parentRunDays = runDaysOf(parentFirstTs);
  const parentId = mappedOriginalIds.size === 1 ? Array.from(mappedOriginalIds)[0] : null;

  // Pair shadow leg (LIVE_SHADOW_MAP) — same-age dedicated twin, already 0.05 size.
  // Gives the 3-way trend check: live (real) / pair (ideal, same window) / parent (original).
  const mappedPairIds = new Set(
    liveClosed.map(t => LIVE_SHADOW_MAP[t.strategy_id]).filter((x): x is string => !!x),
  );
  const pairTrades = shadowTrades.filter(t => t.status === 'closed' && mappedPairIds.has(t.strategy_id));
  const pairNativeTotal = pairTrades.reduce((a, t) => a + (t.net_profit_sol ?? 0), 0);
  const pairSize = pairTrades.find(t => (t.trade_size_sol ?? 0) > 0)?.trade_size_sol ?? null;
  const pairSizeNorm = (liveSize && pairSize && pairSize > 0) ? liveSize / pairSize : 1;
  const pairTotalLiveSize = pairTrades.length ? round(pairNativeTotal * pairSizeNorm) : null;
  const pairFirstTs = firstTsOf(pairTrades.map(t => t.entry_ts));
  const pairRunDays = runDaysOf(pairFirstTs);
  const pairId = mappedPairIds.size === 1 ? Array.from(mappedPairIds)[0] : null;

  // Adjusted live: FULL live net minus the matched pairs where live underperformed
  // its shadow twin by >= ADJ_DIVERGENCE_PP (the execution-failure blowups). Shows
  // what the strategy earns once its worst execution misses are stripped.
  const ADJ_DIVERGENCE_PP = 50;
  const blowupPairs = pairs.filter(p => p.return_delta_pct != null && p.return_delta_pct <= -ADJ_DIVERGENCE_PP);
  const blowupLiveNet = blowupPairs.reduce((a, p) => a + (p.live_net_sol ?? 0), 0);
  const adjLiveNetFull = liveNetFull - blowupLiveNet;

  const runRate: LtComparison['run_rate'] = {
    basis: 'full_strategy_net / days_since_first_trade(min 7) x period (live-size normalized) — same basis as The Analyst',
    live_trade_size_sol: liveSize,
    parent_trade_size_sol: parentSize,
    live: {
      first_entry_ts: liveFirstTs, age_days: ageDaysOf(liveFirstTs), run_days: round(liveRunDays, 1) ?? 7,
      n: liveClosed.length,
      total_net_sol: round(liveNetFull),
      net_per_trade: liveClosed.length ? round(liveNetFull / liveClosed.length, 6) : null,
      weekly_sol: perPeriod(liveNetFull, liveRunDays, 7),
      monthly_sol: perPeriod(liveNetFull, liveRunDays, 30),
    },
    parent: {
      strategy_id: parentId, n: parentTrades.length,
      age_days: ageDaysOf(parentFirstTs), run_days: round(parentRunDays, 1) ?? 7,
      total_net_sol_live_size: parentTotalLiveSize,
      net_per_trade_live_size: (parentTotalLiveSize !== null && parentTrades.length) ? round(parentTotalLiveSize / parentTrades.length, 6) : null,
      weekly_sol: parentTotalLiveSize === null ? null : perPeriod(parentTotalLiveSize, parentRunDays, 7),
      monthly_sol: parentTotalLiveSize === null ? null : perPeriod(parentTotalLiveSize, parentRunDays, 30),
    },
    pair: {
      strategy_id: pairId, n: pairTrades.length,
      age_days: ageDaysOf(pairFirstTs), run_days: round(pairRunDays, 1) ?? 7,
      total_net_sol_live_size: pairTotalLiveSize,
      net_per_trade_live_size: (pairTotalLiveSize !== null && pairTrades.length) ? round(pairTotalLiveSize / pairTrades.length, 6) : null,
      weekly_sol: pairTotalLiveSize === null ? null : perPeriod(pairTotalLiveSize, pairRunDays, 7),
      monthly_sol: pairTotalLiveSize === null ? null : perPeriod(pairTotalLiveSize, pairRunDays, 30),
    },
    adjusted_live: {
      divergence_pp_threshold: ADJ_DIVERGENCE_PP, excluded_n: blowupPairs.length,
      total_net_sol: round(adjLiveNetFull),
      weekly_sol: perPeriod(adjLiveNetFull, liveRunDays, 7),
      monthly_sol: perPeriod(adjLiveNetFull, liveRunDays, 30),
    },
  };

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
    live_longest_win_streak: liveStreak.win,
    live_longest_loss_streak: liveStreak.loss,
    shadow_longest_win_streak: shadowStreak.win,
    shadow_longest_loss_streak: shadowStreak.loss,
    divergence_pp_threshold: DIVERGENCE_PP,
    divergence_count: divLiveWorse + divLiveBetter,
    divergence_live_worse: divLiveWorse,
    divergence_live_better: divLiveBetter,
    divergence_class_counts: divergenceClassCounts,
    run_rate: runRate,
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
      t.trade_size_sol,
      -- Diagnostic prices: effective entry fill; no stored HWM on trades_v2 (null);
      -- TP price derived from the effective entry × (1 + take_profit_pct/100).
      COALESCE(t.entry_effective_price, t.entry_price_sol) AS entry_price,
      NULL AS high_price,
      CASE WHEN t.take_profit_pct IS NOT NULL
           THEN COALESCE(t.entry_effective_price, t.entry_price_sol) * (1 + t.take_profit_pct / 100.0) END AS tp_price,
      NULL AS copy_event_id,
      NULL AS entry_land_path
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
      c.tx_land_ms,
      c.exit_reason,
      c.size_sol AS trade_size_sol,
      -- Diagnostic prices: live rows store the REAL fill in entry_price_sol, the
      -- HWM in high_price_sol, and the TP trigger in tp_price_sol — exactly what
      -- separates an entry-fill miss from an exit-execution miss.
      c.entry_price_sol AS entry_price,
      c.high_price_sol AS high_price,
      c.tp_price_sol AS tp_price,
      c.copy_event_id,
      c.entry_land_path
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
  // Both the execution twin (pair shadow, for the 1:1 panel) AND the original research
  // strategy (trend benchmark in the run-rate block) — fetch trades for both.
  const neededShadowIds = Array.from(new Set([
    ...liveStrategyIds.map(id => LIVE_SHADOW_MAP[id]),
    ...liveStrategyIds.map(id => LIVE_ORIGINAL_MAP[id]),
  ].filter((x): x is string => !!x)));

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
    original_mapping: LIVE_ORIGINAL_MAP,
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
