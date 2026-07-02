import Database from 'better-sqlite3';
import { getTopWalletScores, getSmartSetAddresses, WalletScoreRow } from './queries';

/**
 * Wallet leaderboard — V2 (copy-net ranking). Published as `copy-v2.json`.
 *
 * WHY THIS EXISTS (Option A from the 2026-06-29 wallet audit):
 *   The V1 leaderboard (`leaderboard.ts` → `wallet-leaderboard.json`) ranks and
 *   gates leads by their OWN on-chain P&L (`wallet_scores`: monthly_run_rate_sol,
 *   drop_top3, …). The audit showed that metric has ~zero correlation with how
 *   profitable a wallet is FOR US TO COPY (r = -0.08 vs our copy net; the top
 *   quartile by own-score LOST us SOL). The signal that actually predicts copy
 *   profit is our OWN realized copy net of that lead — and it persists
 *   (split-half autocorr +0.43).
 *
 * WHAT V2 DOES:
 *   Ranks leads by realized copy net (from `copy_trades`), applies a copy-based
 *   gate (n + net + outlier-robust drop_top3 + recency), and publishes a
 *   head-to-head vs the V1 selection so we can SEE whether the copy-net method
 *   would select a more profitable set than own-P&L before we repoint live
 *   selection (that repoint is Option B — NOT done here).
 *
 * SAFETY / FALLBACK:
 *   This module is READ-ONLY and PARALLEL. It does NOT touch `getSmartSetAddresses`,
 *   the follower-probe watchlist, the follow_list, or any strategy gate. V1 remains
 *   the live selector; if V2 looks wrong we simply stop publishing it. Nothing to
 *   roll back in the trading path.
 */

/**
 * Measurement strategy. The baseline `copy-tp100-sl30` copies EVERY watched lead
 * with one uniform ruleset, so per-lead copy net here reflects lead quality, not
 * an exit-rule interaction. (Aggregating across the hotlead family would double-
 * count shared entry signals — see copy-trades.json `paired_vs_baseline`.)
 */
const V2_MEASURE_STRATEGY = 'copy-tp100-sl30';

/**
 * LATENCY-MATCHED measurement baseline (added 2026-07-01). copy-tp100-sl30 fills at the
 * idealized ~1.1s snapshot, but the live copy-select arms enter at entryDelaySec=5 with a
 * drift-10% skip — so selecting leads on 1.1s copy net can favour leads whose edge lives in
 * the first seconds (the live copy-select-v2 arm already skips ~32% of candidates on drift vs
 * ~4% for v1). copy-tp100-sl30-lag copies EVERY watched lead at that SAME 5s+drift10 execution,
 * so once it has history the copy-v2 page (and, via COPYV2_USE_LAG_MEASURE, live selection) can
 * measure lead quality at the latency we actually trade. Until it matures we stay on the fast
 * baseline so the running A/B is not disturbed; `pickMeasureStrategy` handles the safe fallback.
 */
const V2_MEASURE_STRATEGY_LAG = 'copy-tp100-sl30-lag';

/** Min distinct leads with >= minCopies on the lag baseline before it's trusted as the source. */
const LAG_MEASURE_MIN_LEADS = 8;

/**
 * The live A/B twins (Option B): identical realistic ruleset, differ ONLY in lead
 * selection. -v1 copies the own-P&L smart set, -v2 the copy-net set. Their by-strategy
 * copy P&L is the forward test of which selection method picks more profitable leads.
 */
const AB_V1_STRATEGY = 'copy-select-v1';
const AB_V2_STRATEGY = 'copy-select-v2';
/** n_trades per arm at which the live A/B is worth calling. */
const AB_TARGET_N = 100;

/**
 * V2 gate — the copy-net analog of V1's DEFAULT_WALLET_GATE. A lead is
 * "selected" (would enter the watchlist/follow_list under Option B) when its
 * COPIED trades clear all of these. Env-tunable so the bar can be calibrated
 * from data without a redeploy.
 */
export const V2_GATE = {
  minCopies: numEnv('COPYV2_MIN_COPIES', 10),          // enough copies to estimate
  minNetSol: numEnv('COPYV2_MIN_NET_SOL', 0),          // net-positive copied
  minNetDropTop3Sol: numEnv('COPYV2_MIN_DROP_TOP3', 0),// survives removing its 3 best copies
  maxDaysSinceActive: numEnv('COPYV2_MAX_DAYS', 14),   // still trading
  // RECENCY term (added 2026-07-01). The cumulative gate above is structurally
  // `copy-elitelead` — all-time lead reputation — which the lab already found UNDERPERFORMS
  // recency (resolved 2026-06-27). Symptom on the live page: the #1 V2-selected lead has been
  // net-negative for the past 7d yet stays selected. This adds an optional "still hot lately"
  // clause: net over the last `recencyDays` must exceed `minNetRecentSol`. DISABLED by default
  // (minNetRecentSol=NaN) so it does NOT change live selection or disturb the running A/B — the
  // calibration grid on the copy-v2 page scores candidate settings walk-forward so the operator
  // can pick a threshold from data before flipping it on via COPYV2_MIN_NET_RECENT.
  recencyDays: numEnv('COPYV2_RECENCY_DAYS', 7),
  minNetRecentSol: numEnv('COPYV2_MIN_NET_RECENT', NaN),
};

/** Whether the recency clause is active (a finite COPYV2_MIN_NET_RECENT was set). */
export function recencyEnabled(): boolean {
  return Number.isFinite(V2_GATE.minNetRecentSol);
}

/** Flip live V2 selection onto the latency-matched lag baseline (once it has history). */
function useLagMeasure(): boolean {
  return /^(1|true|yes)$/i.test(process.env.COPYV2_USE_LAG_MEASURE || '');
}

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The V2-selected lead set — addresses whose COPIED trades clear V2_GATE. This is
 * the live equivalent of V1's `getSmartSetAddresses` (queries.ts), but gated on
 * realized copy net instead of the wallet's own on-chain P&L. Single source of
 * truth for both the copy-v2 page (`selected_v2`) and the live `leadSelection:'v2'`
 * strategies, so the page and the A/B always agree on who V2 picks. Pure SQL,
 * cheap (no RPC) — safe to call on the copy-trader refresh cadence.
 */
export function getCopyNetSelectedAddresses(db: Database.Database): string[] {
  const nowTs = Math.floor(Date.now() / 1000);
  try {
    const strat = pickMeasureStrategy(db);
    const recentCut = nowTs - V2_GATE.recencyDays * 86_400;
    const rows = db.prepare(`
      WITH ranked AS (
        SELECT lead_wallet AS w, net_sol AS net, entry_ts,
               ROW_NUMBER() OVER (PARTITION BY lead_wallet ORDER BY net_sol DESC) AS rnk
        FROM copy_trades
        WHERE strategy_id = @strat AND status = 'closed'
          AND net_sol IS NOT NULL AND lead_wallet IS NOT NULL
      )
      SELECT w FROM ranked
      GROUP BY w
      HAVING COUNT(*) >= @minCopies
         AND SUM(net) > @minNet
         AND SUM(CASE WHEN rnk > 3 THEN net ELSE 0 END) > @minDrop
         AND (@now - MAX(entry_ts)) / 86400.0 <= @maxDays
         AND (@recencyOff = 1
              OR SUM(CASE WHEN entry_ts >= @recentCut THEN net ELSE 0 END) > @minNetRecent)
    `).all({
      strat,
      minCopies: V2_GATE.minCopies,
      minNet: V2_GATE.minNetSol,
      minDrop: V2_GATE.minNetDropTop3Sol,
      maxDays: V2_GATE.maxDaysSinceActive,
      now: nowTs,
      recencyOff: recencyEnabled() ? 0 : 1,
      recentCut,
      minNetRecent: recencyEnabled() ? V2_GATE.minNetRecentSol : 0,
    }) as Array<{ w: string }>;
    return rows.map((r) => r.w);
  } catch {
    return [];
  }
}

/**
 * PROVEN-BAD exclusion set (2026-07-02) — the pivot from the OOS refutation of positive
 * selection. The one copy-net signal that held up out-of-sample is DOWNSIDE persistence
 * (first-half losing leads → −17.8 SOL second half, vs winners → only +2.5). So instead of
 * selecting winners, VETO proven losers: leads with >= COPYXBAD_MIN_COPIES closed copies on
 * the fast baseline (max sample; latency bias is acceptable for a downside screen) whose
 * all-time copy net is <= COPYXBAD_MAX_NET. Consumed by excludeProvenBadLeads strategies
 * (copy-hotlead-strict-xbad) and reported on the copy-v2 page.
 */
export const XBAD_GATE = {
  minCopies: numEnv('COPYXBAD_MIN_COPIES', 10),
  maxNetSol: numEnv('COPYXBAD_MAX_NET', 0),
};

export function getCopyNetExcludedAddresses(db: Database.Database): string[] {
  try {
    const rows = db.prepare(`
      SELECT lead_wallet AS w FROM copy_trades
      WHERE strategy_id = @strat AND status = 'closed'
        AND net_sol IS NOT NULL AND lead_wallet IS NOT NULL
      GROUP BY lead_wallet
      HAVING COUNT(*) >= @minCopies AND SUM(net_sol) <= @maxNet
    `).all({
      strat: V2_MEASURE_STRATEGY,
      minCopies: XBAD_GATE.minCopies,
      maxNet: XBAD_GATE.maxNetSol,
    }) as Array<{ w: string }>;
    return rows.map((r) => r.w);
  } catch {
    return [];
  }
}

/** Distinct leads with >= minCopies closed copies on a measurement strategy. */
function countMeasurableLeads(db: Database.Database, strat: string): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT lead_wallet FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed'
          AND net_sol IS NOT NULL AND lead_wallet IS NOT NULL
        GROUP BY lead_wallet HAVING COUNT(*) >= ?
      )
    `).get(strat, V2_GATE.minCopies) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Which baseline to measure/select on. Prefers the latency-matched lag baseline ONLY when
 * COPYV2_USE_LAG_MEASURE is set AND it has enough history; otherwise falls back to the fast
 * baseline so live selection never silently empties while the lag twin warms up.
 */
function pickMeasureStrategy(db: Database.Database): string {
  if (useLagMeasure() && countMeasurableLeads(db, V2_MEASURE_STRATEGY_LAG) >= LAG_MEASURE_MIN_LEADS) {
    return V2_MEASURE_STRATEGY_LAG;
  }
  return V2_MEASURE_STRATEGY;
}

interface CopyTradeRow {
  lead_wallet: string;
  lead_tier: string | null;
  net_sol: number;
  entry_ts: number;
  detection_lag_sec: number | null;
}

interface LeadV2Row {
  address: string;
  tier: string | null;
  n_copies: number;
  win_rate: number;
  copy_net_sol: number;
  copy_net_drop_top3_sol: number;
  copy_net_7d_sol: number;
  copy_monthly_run_rate_sol: number;
  avg_detection_lag_sec: number | null;
  last_copy_days_ago: number;
  // persistence: split-half net (the +0.43 signal), null if too few copies
  first_half_net_sol: number | null;
  second_half_net_sol: number | null;
  // the V2 verdict
  selected_v2: boolean;
  failed_gates: string[];
  // V1 side-by-side (their own-PnL score) for the comparison
  v1_monthly_run_rate_sol: number | null;
  v1_win_rate: number | null;
  v1_drop_top3_sol: number | null;
  selected_v1: boolean;
}

function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

interface StatBlock {
  n: number;
  net_sol: number;
  net_drop_top3_sol: number;
  win_rate: number | null;
}

function statBlock(nets: number[]): StatBlock {
  const n = nets.length;
  const total = nets.reduce((a, b) => a + b, 0);
  const wins = nets.filter((x) => x > 0).length;
  const dropTop3 = [...nets].sort((a, b) => b - a).slice(3).reduce((a, b) => a + b, 0);
  return { n, net_sol: round(total), net_drop_top3_sol: round(dropTop3), win_rate: n ? round(wins / n, 3) : null };
}

interface AbArmStats extends StatBlock {
  strategy: string;
  open: number;            // currently-open positions
  net_7d_sol: number;
  progress_pct: number;    // n / AB_TARGET_N, capped at 100
  // The two arms overlap (a lead can be selected by both methods); the trades that
  // actually DISTINGUISH the methods are on each arm's EXCLUSIVE leads. Splitting them
  // out stops n>=AB_TARGET_N from overstating confidence — the exclusive subset is the
  // real test and accrues far slower than the headline n.
  shared: StatBlock;       // trades on leads selected by BOTH methods
  exclusive: StatBlock;    // trades on leads exclusive to THIS arm's method
}

/**
 * Live by-strategy stats for one A/B arm, split by whether the trade's lead is shared with
 * the other method or exclusive to this one. `sharedSet` = leads currently in both selections.
 */
function abArmStats(
  db: Database.Database,
  strategyId: string,
  nowTs: number,
  sharedSet: Set<string>,
): AbArmStats {
  let closed: Array<{ net_sol: number; entry_ts: number; lead_wallet: string | null }> = [];
  let open = 0;
  try {
    closed = db.prepare(
      `SELECT net_sol, entry_ts, lead_wallet FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed' AND net_sol IS NOT NULL`,
    ).all(strategyId) as Array<{ net_sol: number; entry_ts: number; lead_wallet: string | null }>;
    open = (db.prepare(
      `SELECT COUNT(*) AS c FROM copy_trades WHERE strategy_id = ? AND status = 'open'`,
    ).get(strategyId) as { c: number }).c;
  } catch { /* table absent */ }
  const nets = closed.map((r) => r.net_sol);
  const overall = statBlock(nets);
  const sharedNets = closed.filter((r) => r.lead_wallet != null && sharedSet.has(r.lead_wallet)).map((r) => r.net_sol);
  const exclNets = closed.filter((r) => !(r.lead_wallet != null && sharedSet.has(r.lead_wallet))).map((r) => r.net_sol);
  const cut7d = nowTs - 7 * 86_400;
  const net7d = closed.filter((r) => r.entry_ts >= cut7d).reduce((a, b) => a + b.net_sol, 0);
  return {
    strategy: strategyId,
    open,
    ...overall,
    net_7d_sol: round(net7d),
    progress_pct: Math.min(100, Math.round((overall.n / AB_TARGET_N) * 100)),
    shared: statBlock(sharedNets),
    exclusive: statBlock(exclNets),
  };
}

/**
 * A/B resolution verdict. `collecting` until BOTH arms reach AB_TARGET_N; then decide on the
 * outlier-robust drop_top3 (not raw net). Explicitly handles the both-fail case (keep V1 live
 * selection) the old "keep whichever nets more" rule ignored, and flags near-ties as noise
 * given per-trade variance is moonshot-dominated.
 */
function abVerdict(v1: AbArmStats, v2: AbArmStats): Record<string, unknown> {
  const MIN_EDGE_SOL = 2; // below this, an n≈100 net difference is within trade-level noise
  if (v1.n < AB_TARGET_N || v2.n < AB_TARGET_N) {
    return {
      status: 'collecting',
      detail: `need n>=${AB_TARGET_N} per arm (v1=${v1.n}, v2=${v2.n}); do not read early P&L — the A/B launched into the June 29–30 record drawdown.`,
    };
  }
  const v1ok = v1.net_drop_top3_sol > 0;
  const v2ok = v2.net_drop_top3_sol > 0;
  if (!v1ok && !v2ok) {
    return { status: 'both_fail', decision: 'keep V1 live selection', detail: 'neither method is drop3-robust; copy-net selection shows no deployable edge over own-P&L.' };
  }
  const edge = Math.abs(v2.net_sol - v1.net_sol);
  if (v2ok && (!v1ok || v2.net_sol > v1.net_sol)) {
    return { status: 'v2_wins', decision: 'repoint live selection onto copy-net (V2)', detail: edge < MIN_EDGE_SOL ? `edge ${round(edge)} SOL is thin — confirm over more n before flipping.` : `V2 leads by ${round(edge)} SOL with drop3>0.` };
  }
  return { status: 'v1_wins', decision: 'keep V1 live selection', detail: edge < MIN_EDGE_SOL ? `edge ${round(edge)} SOL is thin — treat as inconclusive.` : `V1 leads by ${round(edge)} SOL.` };
}

export function computeWalletLeaderboardV2(db: Database.Database, limit = 50): unknown {
  const nowTs = Math.floor(Date.now() / 1000);

  let trades: CopyTradeRow[] = [];
  let v1Scores: WalletScoreRow[] = [];
  let v1Selected = new Set<string>();
  try {
    trades = db.prepare(
      `SELECT lead_wallet, lead_tier, net_sol, entry_ts, detection_lag_sec
         FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed'
          AND net_sol IS NOT NULL AND lead_wallet IS NOT NULL`,
    ).all(V2_MEASURE_STRATEGY) as CopyTradeRow[];
    // Pull all V1 scores once (cheap) for the side-by-side. limit is generous.
    v1Scores = getTopWalletScores(db, 1_000_000);
    v1Selected = new Set(getSmartSetAddresses(db));
  } catch {
    return {
      generated_at: new Date().toISOString(),
      phase: 'phase2-copy-net-ranking',
      method: 'v2-copy-net',
      note: 'copytrade tables not yet present',
      summary: { measurable_leads: 0 },
      rows: [],
    };
  }

  const v1ByAddr = new Map<string, WalletScoreRow>();
  for (const r of v1Scores) v1ByAddr.set(r.address, r);

  // Group copies by lead.
  const byLead = new Map<string, CopyTradeRow[]>();
  for (const t of trades) {
    const arr = byLead.get(t.lead_wallet);
    if (arr) arr.push(t);
    else byLead.set(t.lead_wallet, [t]);
  }

  const cut7d = nowTs - 7 * 86_400;

  const rows: LeadV2Row[] = [];
  for (const [addr, ts] of byLead) {
    ts.sort((a, b) => a.entry_ts - b.entry_ts);
    const n = ts.length;
    const nets = ts.map((t) => t.net_sol);
    const total = nets.reduce((a, b) => a + b, 0);
    const wins = nets.filter((x) => x > 0).length;

    // drop_top3: remove the 3 largest individual copy nets (outlier robustness).
    const sortedDesc = [...nets].sort((a, b) => b - a);
    const dropTop3 = sortedDesc.slice(3).reduce((a, b) => a + b, 0);

    const net7d = ts.filter((t) => t.entry_ts >= cut7d).reduce((a, b) => a + b.net_sol, 0);

    const firstTs = ts[0].entry_ts;
    const lastTs = ts[n - 1].entry_ts;
    const spanDays = Math.max((lastTs - firstTs) / 86_400, 1);
    const monthlyRunRate = (total / spanDays) * 30;

    const lags = ts.map((t) => t.detection_lag_sec).filter((v): v is number => typeof v === 'number');
    const avgLag = lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null;

    // split-half persistence (needs >=12 copies, mirroring the audit threshold)
    let firstHalf: number | null = null;
    let secondHalf: number | null = null;
    if (n >= 12) {
      const h = Math.floor(n / 2);
      firstHalf = nets.slice(0, h).reduce((a, b) => a + b, 0);
      secondHalf = nets.slice(h).reduce((a, b) => a + b, 0);
    }

    const lastCopyDaysAgo = (nowTs - lastTs) / 86_400;

    // V2 gate
    const failed: string[] = [];
    if (n < V2_GATE.minCopies) failed.push('n_copies');
    if (total <= V2_GATE.minNetSol) failed.push('copy_net');
    if (dropTop3 <= V2_GATE.minNetDropTop3Sol) failed.push('copy_drop_top3');
    if (lastCopyDaysAgo > V2_GATE.maxDaysSinceActive) failed.push('last_active');

    const v1 = v1ByAddr.get(addr);
    rows.push({
      address: addr,
      tier: ts[0].lead_tier,
      n_copies: n,
      win_rate: round(wins / n, 3),
      copy_net_sol: round(total),
      copy_net_drop_top3_sol: round(dropTop3),
      copy_net_7d_sol: round(net7d),
      copy_monthly_run_rate_sol: round(monthlyRunRate, 3),
      avg_detection_lag_sec: avgLag != null ? round(avgLag, 2) : null,
      last_copy_days_ago: round(lastCopyDaysAgo, 1),
      first_half_net_sol: firstHalf != null ? round(firstHalf) : null,
      second_half_net_sol: secondHalf != null ? round(secondHalf) : null,
      selected_v2: failed.length === 0,
      failed_gates: failed,
      v1_monthly_run_rate_sol: v1?.monthly_run_rate_sol ?? null,
      v1_win_rate: v1?.win_rate ?? null,
      v1_drop_top3_sol: v1 != null ? round(v1.total_realized_sol_drop_top3) : null,
      selected_v1: v1Selected.has(addr),
    });
  }

  // Rank by copy net (the V2 sort key), descending.
  rows.sort((a, b) => b.copy_net_sol - a.copy_net_sol);

  // ── Head-to-head: V1 (own-P&L) vs V2 (copy-net) over the MEASURABLE universe
  //    (leads we have >= minCopies copies for — the only place the two methods
  //    can be compared on the outcome that matters).
  const measurable = rows.filter((r) => r.n_copies >= V2_GATE.minCopies);
  const cell = (pred: (r: LeadV2Row) => boolean) => {
    const sub = measurable.filter(pred);
    return { n_leads: sub.length, copy_net_sol: round(sub.reduce((a, b) => a + b.copy_net_sol, 0)) };
  };
  const both = cell((r) => r.selected_v1 && r.selected_v2);
  const v1Only = cell((r) => r.selected_v1 && !r.selected_v2);
  const v2Only = cell((r) => !r.selected_v1 && r.selected_v2);
  const neither = cell((r) => !r.selected_v1 && !r.selected_v2);

  const v2SelectedNet = round(measurable.filter((r) => r.selected_v2).reduce((a, b) => a + b.copy_net_sol, 0));
  const v1SelectedNet = round(measurable.filter((r) => r.selected_v1).reduce((a, b) => a + b.copy_net_sol, 0));

  // ── Walk-forward (out-of-sample). The method_comparison above scores each lead on the
  //    SAME trades used to select it, so copy-net winning on copy net is near-tautological.
  //    Here we GATE V2 using only copies BEFORE a cutoff, then SCORE on copies AFTER it — the
  //    honest "if we'd picked these leads a week ago, did they pay since?" test.
  const WF_WINDOW_DAYS = 7;
  const wfCut = nowTs - WF_WINDOW_DAYS * 86_400;
  const v2SelectAsOf = (
    cutTs: number,
    g: { minCopies: number; recentDays?: number; minNetRecent?: number },
  ): Set<string> => {
    const sel = new Set<string>();
    for (const [addr, ts] of byLead) {
      const pre = ts.filter((t) => t.entry_ts < cutTs);
      if (pre.length < g.minCopies) continue;
      const preNets = pre.map((t) => t.net_sol);
      if (preNets.reduce((a, b) => a + b, 0) <= V2_GATE.minNetSol) continue;
      const drop3 = [...preNets].sort((a, b) => b - a).slice(3).reduce((a, b) => a + b, 0);
      if (drop3 <= V2_GATE.minNetDropTop3Sol) continue;
      if ((cutTs - pre[pre.length - 1].entry_ts) / 86_400 > V2_GATE.maxDaysSinceActive) continue;
      if (g.recentDays != null && g.minNetRecent != null) {
        const rc = cutTs - g.recentDays * 86_400;
        if (pre.filter((t) => t.entry_ts >= rc).reduce((a, b) => a + b.net_sol, 0) <= g.minNetRecent) continue;
      }
      sel.add(addr);
    }
    return sel;
  };
  const postNet = (addr: string, cutTs: number): number =>
    (byLead.get(addr) ?? []).filter((t) => t.entry_ts >= cutTs).reduce((a, b) => a + b.net_sol, 0);

  // V2 reconstructed as-of the cutoff (true OOS). V1's historical smart set can't be rebuilt
  // from copy_trades, so we score the CURRENT V1 set OOS — a choice that if anything FLATTERS
  // V1 (mild look-ahead), i.e. a conservative floor for V2's measured edge.
  const recentGate = recencyEnabled()
    ? { recentDays: V2_GATE.recencyDays, minNetRecent: V2_GATE.minNetRecentSol }
    : {};
  const v2AsOf = v2SelectAsOf(wfCut, { minCopies: V2_GATE.minCopies, ...recentGate });
  const wfAddrs = [...byLead.keys()];
  const wfCell = (pred: (addr: string) => boolean) => {
    const sub = wfAddrs.filter(pred);
    return { n_leads: sub.length, post_cut_copy_net_sol: round(sub.reduce((a, b) => a + postNet(b, wfCut), 0)) };
  };
  const wfBoth = wfCell((a) => v1Selected.has(a) && v2AsOf.has(a));
  const wfV1Only = wfCell((a) => v1Selected.has(a) && !v2AsOf.has(a));
  const wfV2Only = wfCell((a) => !v1Selected.has(a) && v2AsOf.has(a));

  // ── Gate calibration grid: score candidate {minCopies × recency} settings walk-forward so
  //    the operator can pick a threshold from data before flipping the live gate (COPYV2_*).
  const gridDefs = [
    { label: 'minCopies=5', minCopies: 5 },
    { label: 'minCopies=10 (current)', minCopies: 10 },
    { label: 'minCopies=15', minCopies: 15 },
    { label: 'minCopies=10 + recent7d>0', minCopies: 10, recentDays: 7, minNetRecent: 0 },
    { label: 'minCopies=5 + recent7d>0', minCopies: 5, recentDays: 7, minNetRecent: 0 },
  ];
  const gate_grid = gridDefs.map((g) => {
    const addrs = [...v2SelectAsOf(wfCut, g)];
    const post = addrs.reduce((a, b) => a + postNet(b, wfCut), 0);
    return {
      config: g.label,
      n_selected: addrs.length,
      post_cut_copy_net_sol: round(post),
      post_cut_net_per_lead: addrs.length ? round(post / addrs.length, 3) : 0,
    };
  });

  // ── Latency check (#1): is selection measured at the latency we execute? The lag baseline
  //    (copy-tp100-sl30-lag, 5s+drift10) is the honest source; until it matures we measure on
  //    the ~1.1s fast baseline. lag_vs_fast surfaces per-lead net at both latencies once data
  //    exists — sign_flips = leads whose edge does NOT survive the 5s wait.
  const lagLeads = countMeasurableLeads(db, V2_MEASURE_STRATEGY_LAG);
  let lag_vs_fast: unknown = null;
  try {
    const lagTrades = db.prepare(
      `SELECT lead_wallet, net_sol FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed' AND net_sol IS NOT NULL AND lead_wallet IS NOT NULL`,
    ).all(V2_MEASURE_STRATEGY_LAG) as Array<{ lead_wallet: string; net_sol: number }>;
    if (lagTrades.length) {
      const lagByLead = new Map<string, number>();
      for (const t of lagTrades) lagByLead.set(t.lead_wallet, (lagByLead.get(t.lead_wallet) ?? 0) + t.net_sol);
      let sharedN = 0, flips = 0, fastSum = 0, lagSum = 0;
      for (const [addr, lagNet] of lagByLead) {
        const fast = byLead.get(addr);
        if (!fast) continue;
        const fastNet = fast.reduce((a, b) => a + b.net_sol, 0);
        sharedN += 1; fastSum += fastNet; lagSum += lagNet;
        if (Math.sign(fastNet) !== Math.sign(lagNet)) flips += 1;
      }
      lag_vs_fast = {
        shared_leads: sharedN,
        fast_net_sol: round(fastSum),
        lag_net_sol: round(lagSum),
        sign_flips: flips,
        note: 'Per-lead copy net at ~1.1s (fast) vs 5s+drift10 (lag) over leads both baselines have copied. sign_flips = leads that flip profitable⇄unprofitable once the 5s latency is paid.',
      };
    }
  } catch { /* lag baseline absent */ }

  // ── Live A/B: the forward test. copy-select-v1 vs copy-select-v2 are identical realistic
  //    strategies differing ONLY in lead selection. Split each arm's trades by shared vs
  //    exclusive leads (the exclusive subset is what actually distinguishes the methods).
  const v2LiveSet = new Set(getCopyNetSelectedAddresses(db));
  const sharedLiveSet = new Set([...v2LiveSet].filter((a) => v1Selected.has(a)));
  const abV1 = abArmStats(db, AB_V1_STRATEGY, nowTs, sharedLiveSet);
  const abV2 = abArmStats(db, AB_V2_STRATEGY, nowTs, sharedLiveSet);
  // 2026-07-02: A/B RESOLVED EARLY by the walk-forward evidence, not by arm n. OOS, V2's
  // unique picks lost (−2.43 SOL / 4 leads) while V1-only leads gained (+1.60 / 34); every
  // gate_grid config was OOS-negative; the arms' exclusive splits agreed. Positive copy-net
  // selection refuted; arms killed. Stats below are the frozen final series (closed rows).
  const ab_verdict = {
    status: 'resolved_refuted',
    decision: 'keep V1 live selection; V2 positive selection killed 2026-07-02',
    detail:
      'Refuted by walk-forward (OOS) evidence rather than arm-n: v2-only leads −2.43 SOL post-cutoff vs ' +
      'v1-only +1.60; all gate_grid configs OOS-negative; exclusive splits concurred (v2 −3.55 vs v1 −1.10). ' +
      'Surviving signal = downside persistence → proven-bad EXCLUSION (see exclusion block / copy-hotlead-strict-xbad).',
    resolved_at: '2026-07-02',
    superseded_by: abVerdict(abV1, abV2), // what the n-gated rule would still say (context only)
  };
  // The incumbent-based twin (copy-hotlead-strict-v2) vs its live control (copy-hotlead-strict):
  // does copy-net selection add anything ON TOP of what would actually go live?
  const abStrictV2 = abArmStats(db, 'copy-hotlead-strict-v2', nowTs, sharedLiveSet);
  const abStrictControl = abArmStats(db, 'copy-hotlead-strict', nowTs, sharedLiveSet);

  // Proven-bad exclusion set (the pivot) — size + how much those leads have cost, for the page.
  const excludedSet = getCopyNetExcludedAddresses(db);
  const excludedNet = round(excludedSet.reduce(
    (a, addr) => a + (byLead.get(addr) ?? []).reduce((x, t) => x + t.net_sol, 0), 0));

  // Persistence read-out across measurable leads with split-half data.
  const persisters = measurable.filter((r) => r.first_half_net_sol != null);
  const hotThenNet = round(
    persisters.filter((r) => (r.first_half_net_sol as number) > 0)
      .reduce((a, b) => a + (b.second_half_net_sol as number), 0),
  );
  const coldThenNet = round(
    persisters.filter((r) => (r.first_half_net_sol as number) <= 0)
      .reduce((a, b) => a + (b.second_half_net_sol as number), 0),
  );

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-copy-net-ranking',
    method: 'v2-copy-net',
    note:
      'V2 ranks/gates leads by REALIZED COPY NET (copy_trades on the ' +
      `${V2_MEASURE_STRATEGY} baseline), not by the wallet's own on-chain P&L (that is V1 / ` +
      'wallet-leaderboard.json). READ-ONLY comparison page — V1 is still the live selector; ' +
      'repointing live selection onto copy-net is Option B (not done here). copy_net is at the ' +
      'recorded shadow size (size_sol on the baseline) and is already net of the SIM round-trip cost.',
    // Read these before trusting any headline number on this page.
    caveats: [
      'method_comparison.in_sample scores each lead on the SAME trades used to select it — it is circular and structurally flatters V2. Use method_comparison.walk_forward (out-of-sample) and the live ab_live instead.',
      `selection is measured on ${V2_MEASURE_STRATEGY} (~1.1s fills) but executed at 5s+drift10; see measurement.lag_vs_fast for whether lead edge survives the real latency.`,
      'ab_live launched 2026-07-01 into the June 29–30 record drawdown — do not read early P&L; wait for n>=target_n and the exclusive-lead split.',
    ],
    measurement: {
      measure_strategy_fast: V2_MEASURE_STRATEGY,
      measure_strategy_lag: V2_MEASURE_STRATEGY_LAG,
      execution_latency_sec: 5,
      live_source: pickMeasureStrategy(db),
      lag_measurable_leads: lagLeads,
      lag_measure_min_leads: LAG_MEASURE_MIN_LEADS,
      recency_gate_enabled: recencyEnabled(),
      note: 'live_source is what live V2 selection currently reads. It stays on the fast baseline until the lag baseline has >= lag_measure_min_leads leads AND COPYV2_USE_LAG_MEASURE is set, so the running A/B is not disturbed.',
      lag_vs_fast,
    },
    measure_strategy: V2_MEASURE_STRATEGY,
    gate: V2_GATE,
    summary: {
      measurable_leads: measurable.length,
      v2_selected: measurable.filter((r) => r.selected_v2).length,
      v1_selected_measurable: measurable.filter((r) => r.selected_v1).length,
    },
    // Does copy-net selection capture more realized copy profit than own-P&L selection?
    method_comparison: {
      in_sample: {
        note:
          'CIRCULAR — scores leads on the same trades used to select them. Retained for continuity; ' +
          'do not cite as evidence. copy_net_sol per cell = sum of realized copy net for the leads in it.',
        v2_selected_total_copy_net_sol: v2SelectedNet,
        v1_selected_total_copy_net_sol: v1SelectedNet,
        agreement: { both, v1_only: v1Only, v2_only: v2Only, neither },
      },
      walk_forward: {
        note:
          `OUT-OF-SAMPLE — V2 selection is gated on copies BEFORE T-${WF_WINDOW_DAYS}d, scored on copies AFTER. ` +
          'V1 uses its CURRENT set scored OOS (its historical set is not reconstructable), which mildly ' +
          'flatters V1 — so v2_only beating v1_only here is a conservative read of V2 edge. Positive ' +
          'v2_only + negative v1_only = copy-net finds forward edge own-P&L misses.',
        window_days: WF_WINDOW_DAYS,
        both: wfBoth,
        v1_only: wfV1Only,
        v2_only: wfV2Only,
      },
    },
    // Gate calibration — walk-forward net of candidate gate settings (pick from data, then set COPYV2_*).
    gate_grid: {
      note: `Each config's V2 selection gated as-of T-${WF_WINDOW_DAYS}d, scored on the ${WF_WINDOW_DAYS}d since. Higher post_cut_net_per_lead = a better-calibrated gate. 'current' is the live setting.`,
      rows: gate_grid,
    },
    // Live forward test — the two arms' actual by-strategy copy P&L, plus the incumbent twin.
    ab_live: {
      note:
        'copy-select-v1 (own-P&L) vs copy-select-v2 (copy-net): identical realistic strategies differing ' +
        'ONLY in lead selection. Judge on shared vs exclusive: the exclusive-lead split is what actually ' +
        'distinguishes the methods (shared leads land in both arms). Resolve per ab_verdict, not raw net.',
      target_n: AB_TARGET_N,
      v1: abV1,
      v2: abV2,
      verdict: ab_verdict,
      // Selection layered on the ONLY promotable strategy — RESOLVED 2026-07-02 with the A/B:
      // strict-v2 killed at n=3 alongside the refuted positive-selection thesis. Frozen series.
      on_incumbent: {
        note: 'RESOLVED 2026-07-02 (killed with the A/B — positive selection refuted OOS before this twin accumulated n). Successor experiment: copy-hotlead-strict-xbad (proven-bad EXCLUSION on the same incumbent, see exclusion block).',
        v2: abStrictV2,
        control: abStrictControl,
      },
    },
    // The PIVOT: the surviving copy-net signal, deployed as a veto. Leads with a proven-
    // negative all-time baseline copy record; excludeProvenBadLeads strategies skip them.
    exclusion: {
      note:
        `Proven-bad veto set (copy-net as EXCLUSION, not selection): >= ${XBAD_GATE.minCopies} baseline copies ` +
        `with all-time net <= ${XBAD_GATE.maxNetSol} SOL. Motivation: downside persistence is the one OOS-robust ` +
        'copy-net signal (losers → −17.8 second-half vs winners +2.5). Live consumer: copy-hotlead-strict-xbad ' +
        '(resolve vs copy-hotlead-strict at n>=100 on drop3 AND net/trade). Tune via COPYXBAD_MIN_COPIES / COPYXBAD_MAX_NET.',
      gate: XBAD_GATE,
      n_excluded: excludedSet.length,
      excluded_total_copy_net_sol: excludedNet,
    },
    persistence: {
      note: 'Split-half (leads with >=12 copies): does first-half copy profit predict second-half?',
      n_leads: persisters.length,
      first_half_winners_second_half_net_sol: hotThenNet,
      first_half_losers_second_half_net_sol: coldThenNet,
    },
    rows: rows.slice(0, limit),
  };
}
