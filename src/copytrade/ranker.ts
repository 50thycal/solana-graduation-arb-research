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
