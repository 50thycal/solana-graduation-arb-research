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
};

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
    `).all({
      strat: V2_MEASURE_STRATEGY,
      minCopies: V2_GATE.minCopies,
      minNet: V2_GATE.minNetSol,
      minDrop: V2_GATE.minNetDropTop3Sol,
      maxDays: V2_GATE.maxDaysSinceActive,
      now: nowTs,
    }) as Array<{ w: string }>;
    return rows.map((r) => r.w);
  } catch {
    return [];
  }
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
    measure_strategy: V2_MEASURE_STRATEGY,
    gate: V2_GATE,
    summary: {
      measurable_leads: measurable.length,
      v2_selected: measurable.filter((r) => r.selected_v2).length,
      v1_selected_measurable: measurable.filter((r) => r.selected_v1).length,
    },
    // The headline the operator asked for: does copy-net selection capture more
    // realized copy profit than own-P&L selection?
    method_comparison: {
      note:
        'Over the measurable universe (leads with >= minCopies copies). copy_net_sol per cell = ' +
        'sum of realized copy net for the leads in that cell. v1_only = own-P&L says follow but ' +
        'copy-net says no (slots V1 spends that do not pay); v2_only = copy-net finds edge V1 misses.',
      v2_selected_total_copy_net_sol: v2SelectedNet,
      v1_selected_total_copy_net_sol: v1SelectedNet,
      agreement: { both, v1_only: v1Only, v2_only: v2Only, neither },
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
