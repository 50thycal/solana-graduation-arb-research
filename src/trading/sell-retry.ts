import { SWAP_SLIPPAGE_BPS } from './config';

/** Shared live-sell retry schedule (2026-05-27, extracted to its own module
 *  2026-06-19). Both the main trading path (`strategy-manager.handleExit`) and
 *  the copy-live exit path (`copy-trader.closeLivePosition`) drive the SAME
 *  escalating schedule + terminal-error rules so the two execution engines can
 *  never drift apart (mirrors the `buy-retry.ts` split for the buy side).
 *
 *  Pre-fix the main path retried up to 20 times with [2s/5s/10s/30s/60s × N]
 *  backoff and flat 10% slippage on every attempt — up to 17 min to terminal-
 *  close stuck positions, most retries fighting the same Custom 6004 because the
 *  AMM math hadn't changed. The copy-live path was even worse: it fired ONE sell
 *  with no overrides and, on failure, left the position open and re-attempted it
 *  every poll FOREVER — a "no tokens" / reverting position is unsellable, so this
 *  hammered the RPC limiter until the Helius credit budget blew (2026-06-19).
 *
 *  New approach — 9 attempts total, no explicit backoff (poll cadence is the
 *  floor). Each attempt escalates slippage AND/OR Jito tip to break out of the
 *  failure mode:
 *
 *    Attempt 1: 10% slippage, 1× tip — normal exit (most trades succeed here)
 *    Attempt 2: 20% slippage, 5× tip — bump tip aggressively for faster land
 *    Attempt 3: 20% slippage, 5× tip — one more shot with high tip
 *    Attempt 4: 40% slippage, 1× tip — high tip didn't help, crank slippage
 *    Attempt 5: 50% slippage, 1× tip — slippage ramp
 *    Attempt 6: 60% slippage, 1× tip
 *    Attempt 7: 70% slippage, 1× tip
 *    Attempt 8: 80% slippage, 1× tip
 *    Attempt 9: 90% slippage, 1× tip — last attempt (terminal close after)
 *
 *  After attempt 9 fails, the caller closes the position terminally (realized
 *  loss in the main path; parked with net_sol=NULL in the copy-live path). */
export const MAX_SELL_ATTEMPTS_BEFORE_TERMINAL = 9;

/** Per-attempt slippage tolerance in basis points. Index 0 = attempt 1.
 *  Attempt 1 uses the default SWAP_SLIPPAGE_BPS (env-configurable, typically
 *  1000 = 10%); attempts 2+ use absolute values from this table. */
const SELL_RETRY_SLIPPAGE_BPS: ReadonlyArray<number | null> = [
  null,   // 1: SWAP_SLIPPAGE_BPS default
  2000,   // 2: 20%
  2000,   // 3: 20%
  4000,   // 4: 40%
  5000,   // 5: 50%
  6000,   // 6: 60%
  7000,   // 7: 70%
  8000,   // 8: 80%
  9000,   // 9: 90%
];
export function sellSlippageBpsForAttempt(attemptNumber: number): number {
  if (attemptNumber < 1) return SWAP_SLIPPAGE_BPS;
  const idx = Math.min(attemptNumber - 1, SELL_RETRY_SLIPPAGE_BPS.length - 1);
  return SELL_RETRY_SLIPPAGE_BPS[idx] ?? SWAP_SLIPPAGE_BPS;
}

/** Per-attempt Jito tip multiplier vs DEFAULT_JITO_TIP_SOL. Attempts 2-3
 *  use 5× to push the bundle up Jito's priority queue and reduce tx_land_ms.
 *  If that doesn't land the sell, attempt 4+ drops back to 1× since paying
 *  more tip on a tx that's failing for slippage/AMM-state reasons just burns
 *  SOL — switch to widening slippage instead. */
const SELL_RETRY_TIP_MULTIPLIER: ReadonlyArray<number> = [
  1,  // 1: default
  5,  // 2: aggressive land
  5,  // 3: aggressive land
  1,  // 4: back to normal, slippage takes over
  1,  // 5
  1,  // 6
  1,  // 7
  1,  // 8
  1,  // 9
];
export function sellTipMultiplierForAttempt(attemptNumber: number): number {
  if (attemptNumber < 1) return 1;
  const idx = Math.min(attemptNumber - 1, SELL_RETRY_TIP_MULTIPLIER.length - 1);
  return SELL_RETRY_TIP_MULTIPLIER[idx];
}

/** Error patterns that indicate a sell will never succeed — close terminally
 *  immediately instead of waiting out the full attempt schedule. Pattern match
 *  is case-insensitive substring. A successful balance read of 0 surfaces as
 *  'no tokens in wallet' (RPC *failures* throw and are caught as generic errors,
 *  not this), so closing on it is authoritative, not a transient-zero risk. */
export const TERMINAL_SELL_ERROR_PATTERNS = [
  'no tokens in wallet',           // wallet is confirmed empty for this mint
  'pool reserves read failed',     // pool is dead / migrated / removed
  'pool context incomplete',       // pool was never resolvable
];
