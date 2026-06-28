import type { WalletScore } from './wallet-pnl';

/**
 * Wallet ranker — applies the SAME promotion bar the strategy book uses, but
 * per wallet. A wallet that clears every gate is a follow CANDIDATE; it still
 * graduates to live size only after its COPIED trades (Phase 2 shadow) clear
 * the bar again, so this is a necessary-not-sufficient filter.
 */

export interface WalletGateConfig {
  minRoundTrips: number;       // n>=100 floor
  minTotalSol: number;         // total>=0.5
  minDropTop3Sol: number;      // drop_top3>0 (outlier robustness)
  minMonthlyRunRate: number;   // monthly>=3.75
  maxDaysSinceActive: number;  // dead alpha is not alpha
}

export const DEFAULT_WALLET_GATE: WalletGateConfig = {
  minRoundTrips: 100,
  minTotalSol: 0.5,
  minDropTop3Sol: 0,
  minMonthlyRunRate: 3.75,
  maxDaysSinceActive: 14,
};

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * COPYABILITY thresholds. A wallet can have real on-chain P&L yet be impossible
 * for US to copy — the scorer surfaces high-realized wallets indiscriminately, but
 * the best are often bonding-curve scalpers (CZMvsf/iGiyBN: ~99% win rate, ~3-min
 * holds, almost all pumpfun_bc) whose edge is curve speed we can't win. These
 * gates keep only wallets we can actually mirror:
 *   - predominantly post-grad PumpSwap (the venue our executor trades), not curve;
 *   - holds we can realistically land into (minutes-to-hours, not seconds);
 *   - win rates that reflect directional edge, not a structural-speed artifact.
 * Applied to the COPY paths only (watchlist / cohorts / follow-list), never to the
 * smart-money analysis population. All env-tunable.
 */
export const COPYABILITY = {
  minPumpswapShare: numEnv('COPY_MIN_PUMPSWAP_SHARE', 0.5),
  minHoldSec: numEnv('COPY_MIN_HOLD_SEC', 300),
  maxWinRate: numEnv('COPY_MAX_WIN_RATE', 0.95),
};

/** True if a scored wallet is one we could realistically copy (see COPYABILITY). */
export function isCopyable(score: WalletScore): boolean {
  const venuesTotal = Object.values(score.venues ?? {}).reduce((a, b) => a + b, 0);
  const pumpswapShare = venuesTotal > 0 ? (score.venues['pumpswap'] ?? 0) / venuesTotal : 0;
  if (pumpswapShare < COPYABILITY.minPumpswapShare) return false;
  if (score.avgHoldSec == null || score.avgHoldSec < COPYABILITY.minHoldSec) return false;
  if (score.winRate != null && score.winRate > COPYABILITY.maxWinRate) return false;
  return true;
}

export interface RankedWallet {
  score: WalletScore;
  passed: boolean;
  failedGates: string[];
}

export function evaluateWallet(
  score: WalletScore,
  nowTs: number,
  gate: WalletGateConfig = DEFAULT_WALLET_GATE,
): RankedWallet {
  const failed: string[] = [];

  if (score.nRoundTrips < gate.minRoundTrips) failed.push('n_round_trips');
  if (score.totalRealizedSol < gate.minTotalSol) failed.push('total_realized_sol');
  if (score.totalRealizedSolDropTop3 <= gate.minDropTop3Sol) failed.push('drop_top3');
  if (score.monthlyRunRateSol == null || score.monthlyRunRateSol < gate.minMonthlyRunRate) {
    failed.push('monthly_run_rate');
  }
  if (score.lastActive == null
    || (nowTs - score.lastActive) / 86_400 > gate.maxDaysSinceActive) {
    failed.push('last_active');
  }

  // Copyability — real P&L but unmirrorable edge (curve scalpers etc.). Distinct
  // labels so the leaderboard shows WHICH dimension excluded the wallet.
  const venuesTotal = Object.values(score.venues ?? {}).reduce((a, b) => a + b, 0);
  const pumpswapShare = venuesTotal > 0 ? (score.venues['pumpswap'] ?? 0) / venuesTotal : 0;
  if (pumpswapShare < COPYABILITY.minPumpswapShare) failed.push('copyable_venue');
  if (score.avgHoldSec == null || score.avgHoldSec < COPYABILITY.minHoldSec) failed.push('copyable_hold');
  if (score.winRate != null && score.winRate > COPYABILITY.maxWinRate) failed.push('copyable_winrate');

  return { score, passed: failed.length === 0, failedGates: failed };
}

/**
 * Rank a batch of scores: promotable wallets first (by monthly run rate), then
 * the rest. The caller decides how many to write to follow_list and whether to
 * enable them (Phase 1 writes them DISABLED — shadow validation comes first).
 */
export function rankWallets(
  scores: WalletScore[],
  nowTs: number,
  gate: WalletGateConfig = DEFAULT_WALLET_GATE,
): RankedWallet[] {
  return scores
    .map((s) => evaluateWallet(s, nowTs, gate))
    .sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1;
      return (b.score.monthlyRunRateSol ?? -Infinity) - (a.score.monthlyRunRateSol ?? -Infinity);
    });
}
