import { SWAP_SLIPPAGE_BPS } from './config';

/** Shared live-buy retry schedule (2026-05-27, extracted to its own module
 *  2026-06-19). Both the main trading path (`trade-evaluator`) and the
 *  copy-live path (`copy-live-executor`) drive the SAME escalating schedule so
 *  the two execution engines can never drift apart. Previously these were
 *  module-private in `trade-evaluator`.
 *
 *  Pre-fix the live buy was a single attempt — any failure (Custom 6004
 *  ExceededSlippage / InsufficientFundsForRent / a tx that didn't land) marked
 *  the trade failed. Most are salvageable with a retry at higher Jito tip and/or
 *  wider slippage.
 *
 *  3 attempts max — entry timing is critical; we can't burn too long retrying or
 *  we enter late on a fast-moving token:
 *
 *    Attempt 1: SWAP_SLIPPAGE_BPS, 1× tip — normal entry (most trades succeed)
 *    Attempt 2: SWAP_SLIPPAGE_BPS, 5× tip — bump Jito priority for faster land
 *    Attempt 3: 2× SWAP_SLIPPAGE_BPS (capped at 2000 bps), 5× tip — widen
 *               slippage room; last shot before terminal fail
 *
 *  After attempt 3 fails the caller marks the trade failed
 *  (`buy_failed_after_3_attempts`). The buy retry is shorter than the sell retry
 *  (3 vs 9) because a late entry on a fast-moving graduation is worse than no
 *  entry — we can't widen slippage too far without making bad entries. */
export const MAX_BUY_ATTEMPTS = 3;
export const BUY_MAX_SLIPPAGE_BPS = 2000;  // 20% absolute cap on attempt-3 slippage

export function buySlippageBpsForAttempt(attemptNumber: number): number {
  if (attemptNumber <= 2) return SWAP_SLIPPAGE_BPS;
  return Math.min(SWAP_SLIPPAGE_BPS * 2, BUY_MAX_SLIPPAGE_BPS);
}

export function buyTipMultiplierForAttempt(attemptNumber: number): number {
  return attemptNumber === 1 ? 1 : 5;
}
