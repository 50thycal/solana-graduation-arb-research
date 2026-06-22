import Database from 'better-sqlite3';
import { getTopWalletScores, countCandidates, getTopUnscoredByPriority, WalletScoreRow } from './queries';
import { evaluateWallet, DEFAULT_WALLET_GATE } from './ranker';

/**
 * Read-only wallet-leaderboard view for publication to the bot-status branch.
 *
 * Pure SQL reads from wallet_scores (populated out-of-band by CopytradeWorker)
 * — NO RPC, NO heavy compute — so it's safe to call every 2-min gist-sync
 * cycle. The actual scoring is the slow part and runs on the worker's own
 * cadence; this just serializes the latest snapshot.
 */

function rowToScore(r: WalletScoreRow) {
  return {
    address: r.address,
    nRoundTrips: r.n_round_trips,
    totalRealizedSol: r.total_realized_sol,
    totalRealizedSolDropTop3: r.total_realized_sol_drop_top3,
    medianRtPct: r.median_rt_pct,
    monthlyRunRateSol: r.monthly_run_rate_sol,
    winRate: r.win_rate,
    avgHoldSec: r.avg_hold_sec,
    lastActive: r.last_active,
    venues: r.venues_json ? (JSON.parse(r.venues_json) as Record<string, number>) : {},
  };
}

export function computeWalletLeaderboard(db: Database.Database, limit = 50): unknown {
  const nowTs = Math.floor(Date.now() / 1000);

  let scored: WalletScoreRow[] = [];
  let totalCandidates = 0;
  let scoredCount = 0;
  let queuePreview: Array<{ address: string; priority: number | null }> = [];
  try {
    scored = getTopWalletScores(db, limit);
    totalCandidates = countCandidates(db);
    scoredCount = (db.prepare(`SELECT COUNT(*) AS c FROM wallet_scores`).get() as { c: number }).c;
    queuePreview = getTopUnscoredByPriority(db, 10);
  } catch {
    // Tables absent on an older DB — return an explicit empty view rather than throwing.
    return {
      generated_at: new Date().toISOString(),
      phase: 'phase1-offline-pnl',
      note: 'copytrade tables not yet present',
      summary: { total_candidates: 0, scored: 0, promotable: 0 },
      rows: [],
    };
  }

  // Recent activity (freshness): round-trips closed in the last 24h / 7d, per wallet.
  // Bounded by scoring recency — a wallet scored >24h ago won't reflect brand-new
  // trades, which is exactly what last_active_days_ago discloses. One grouped query.
  const cut7d = nowTs - 7 * 86_400;
  const cut24h = nowTs - 86_400;
  const recentByAddr = new Map<string, { rt_24h: number; rt_7d: number }>();
  try {
    const recent = db.prepare(
      `SELECT address,
         SUM(CASE WHEN close_ts >= ? THEN 1 ELSE 0 END) AS rt_24h,
         COUNT(*) AS rt_7d
       FROM wallet_round_trips WHERE close_ts >= ? GROUP BY address`,
    ).all(cut24h, cut7d) as Array<{ address: string; rt_24h: number; rt_7d: number }>;
    for (const r of recent) recentByAddr.set(r.address, { rt_24h: r.rt_24h, rt_7d: r.rt_7d });
  } catch { /* wallet_round_trips absent on older DB — leave counts at 0 */ }

  const rows = scored.map((r) => {
    const ev = evaluateWallet(rowToScore(r), nowTs);
    return {
      address: r.address,
      n_round_trips: r.n_round_trips,
      total_realized_sol: +r.total_realized_sol.toFixed(4),
      total_realized_sol_drop_top3: +r.total_realized_sol_drop_top3.toFixed(4),
      median_rt_pct: r.median_rt_pct,
      monthly_run_rate_sol: r.monthly_run_rate_sol != null ? +r.monthly_run_rate_sol.toFixed(3) : null,
      win_rate: r.win_rate != null ? +r.win_rate.toFixed(3) : null,
      avg_hold_sec: r.avg_hold_sec != null ? Math.round(r.avg_hold_sec) : null,
      last_active_days_ago: r.last_active != null ? +((nowTs - r.last_active) / 86_400).toFixed(1) : null,
      rt_24h: recentByAddr.get(r.address)?.rt_24h ?? 0,
      rt_7d: recentByAddr.get(r.address)?.rt_7d ?? 0,
      venues: r.venues_json ? JSON.parse(r.venues_json) : {},
      passed_gate: ev.passed,
      failed_gates: ev.failedGates,
    };
  });

  // WATCH tier: the money-edge is genuinely there (positive total + survives
  // drop_top3 + clears the monthly bar) but the wallet fails ONLY on sample
  // size or recency — i.e. real-looking alpha that just needs more trades or
  // has gone quiet. Worth tracking separately from outright rejects.
  const moneyGatesOk = (r: typeof rows[number]) =>
    r.total_realized_sol >= DEFAULT_WALLET_GATE.minTotalSol
    && r.total_realized_sol_drop_top3 > DEFAULT_WALLET_GATE.minDropTop3Sol
    && (r.monthly_run_rate_sol ?? 0) >= DEFAULT_WALLET_GATE.minMonthlyRunRate;
  const watch = rows.filter(
    (r) => !r.passed_gate
      && moneyGatesOk(r)
      && r.failed_gates.every((g) => g === 'n_round_trips' || g === 'last_active'),
  );

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase1-offline-pnl',
    // Documents the bar so a reader knows what passed_gate means without
    // cross-referencing CLAUDE.md — mirrors the strategy promotion bar.
    gate: {
      min_round_trips: DEFAULT_WALLET_GATE.minRoundTrips,
      min_total_sol: DEFAULT_WALLET_GATE.minTotalSol,
      min_drop_top3_sol: DEFAULT_WALLET_GATE.minDropTop3Sol,
      min_monthly_run_rate_sol: DEFAULT_WALLET_GATE.minMonthlyRunRate,
      max_days_since_active: DEFAULT_WALLET_GATE.maxDaysSinceActive,
    },
    summary: {
      total_candidates: totalCandidates,
      scored: scoredCount,
      promotable: rows.filter((r) => r.passed_gate).length,
      watch: watch.length,
    },
    // Highest-priority wallets the scorer will evaluate next (by in-DB signal:
    // frequency on PUMP graduations + first-buyer hits). Lets us confirm the
    // queue is sensibly ordered rather than scoring address-sorted randoms.
    queue_preview: queuePreview.map((q) => ({
      address: q.address,
      priority: q.priority,
    })),
    watch,
    rows,
  };
}
