/**
 * Live-mode safety primitives.
 *
 * Composition of four small checks called in order from TradeEvaluator before
 * openTrade, plus a 10s watchdog loop in StrategyManager that re-checks the
 * killswitch and circuit breaker so mid-session trips force-close open
 * positions.
 *
 *   1. Killswitch   — TRADING_KILLSWITCH env or .trading-kill file
 *   2. Circuit breaker — daily net_profit_sol ≤ -DAILY_MAX_LOSS_SOL
 *   3. Wallet balance — SOL ≥ tradeSize + WALLET_SOL_BUFFER
 *   4. Expected slippage — AMM impact ≤ maxSlippageBps
 *
 * All checks return a normalized `SafetyCheck` with `ok: boolean` and a
 * reason string. Paper / shadow modes skip checks 3 & 4 (no tx submitted).
 */

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import type { Wallet } from './wallet';
import {
  DAILY_MAX_LOSS_SOL,
  WALLET_SOL_BUFFER,
  KILLSWITCH_FILE,
  DEFAULT_RISK_HALT_LAST_N_TRADES,
  DEFAULT_RISK_HALT_MAX_DRAWDOWN_SOL,
  type ExecutionMode,
} from './config';
import { computeExpectedBaseOut } from './pumpswap-swap';
import { getStrategyRollingLivePnl } from '../db/queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-safety');

export interface SafetyCheck {
  ok: boolean;
  reason?: string;
  /** Extra context for skip logging (value that failed, threshold that was exceeded) */
  value?: number;
}

/** Returns true if either the env flag or file flag is active. */
export function isKillswitchTripped(): boolean {
  if (process.env.TRADING_KILLSWITCH === '1' || process.env.TRADING_KILLSWITCH === 'true') {
    return true;
  }
  try {
    const p = path.resolve(process.cwd(), KILLSWITCH_FILE);
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Sum `net_profit_sol` across closed live trades in the current UTC day. */
export function getDailyLiveNetProfitSol(db: Database.Database): number {
  // UTC midnight seconds for "today".
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startSec = Math.floor(utcMidnight / 1000);
  const row = db.prepare(`
    SELECT COALESCE(SUM(net_profit_sol), 0) AS pnl
    FROM trades_v2
    WHERE status = 'closed'
      AND execution_mode IN ('live_micro', 'live_full')
      AND exit_timestamp >= ?
  `).get(startSec) as { pnl: number };
  return Number(row?.pnl ?? 0);
}

export function checkCircuitBreaker(db: Database.Database): SafetyCheck {
  const pnl = getDailyLiveNetProfitSol(db);
  if (pnl <= -DAILY_MAX_LOSS_SOL) {
    return {
      ok: false,
      reason: `circuit_breaker: daily live P&L ${pnl.toFixed(4)} SOL ≤ -${DAILY_MAX_LOSS_SOL}`,
      value: pnl,
    };
  }
  return { ok: true };
}

/**
 * Per-strategy rolling-drawdown breaker.
 *
 * Trips when: SUM(net_profit_sol) over the last N closed live trades for this
 * strategy < `maxDrawdownSol` AND the window is full (≥ N trades). Live-only
 * — paper/shadow trades are excluded from the rolling sum, so a paper/shadow
 * strategy can never trip. The check itself short-circuits for non-live
 * execution modes too — a strategy must be actively risking real money for
 * the breaker to engage.
 *
 * Returns `ok: false` with a `reason` string suitable for logging into
 * strategy_configs.risk_halt_reason. Caller (StrategyManager.safetyTick or
 * TradeEvaluator preflight) is responsible for actually halting the strategy.
 */
export function checkStrategyRiskHalt(
  db: Database.Database,
  args: {
    strategyId: string;
    executionMode: ExecutionMode;
    riskHaltLastNTrades?: number;
    riskHaltMaxDrawdownSol?: number;
  },
): SafetyCheck {
  // Only protect live cohorts — paper/shadow halts would just freeze data
  // collection on a research strategy that hasn't risked real money yet.
  if (args.executionMode !== 'live_micro' && args.executionMode !== 'live_full') {
    return { ok: true };
  }
  const windowN = args.riskHaltLastNTrades ?? DEFAULT_RISK_HALT_LAST_N_TRADES;
  const floorSol = args.riskHaltMaxDrawdownSol ?? DEFAULT_RISK_HALT_MAX_DRAWDOWN_SOL;
  // Window=0 means the breaker is opt-out for this strategy.
  if (!Number.isFinite(windowN) || windowN <= 0) {
    return { ok: true };
  }
  if (!Number.isFinite(floorSol)) {
    return { ok: true };
  }
  const { n_trades, sum_net_profit_sol } = getStrategyRollingLivePnl(db, args.strategyId, windowN);
  // Don't trip until window is fully populated — avoids early false trips.
  if (n_trades < windowN) {
    return { ok: true };
  }
  if (sum_net_profit_sol < floorSol) {
    return {
      ok: false,
      reason:
        `risk_halt: rolling P&L ${sum_net_profit_sol.toFixed(4)} SOL over last ` +
        `${windowN} live trades < ${floorSol.toFixed(4)} SOL floor`,
      value: sum_net_profit_sol,
    };
  }
  return { ok: true };
}

export async function checkWalletBalance(
  wallet: Wallet,
  connection: Connection,
  tradeSizeSol: number,
): Promise<SafetyCheck> {
  const lamports = await wallet.getSolBalance(connection);
  const sol = lamports / 1e9;
  const required = tradeSizeSol + WALLET_SOL_BUFFER;
  if (sol < required) {
    return {
      ok: false,
      reason: `insufficient_balance: ${sol.toFixed(4)} SOL < required ${required.toFixed(4)} SOL`,
      value: sol,
    };
  }
  return { ok: true };
}

/** Compute expected slippage (bps) for a tradeSize buy, reject if > ceiling. */
export function checkExpectedSlippage(
  solReserves: number,
  tokenReserves: number,
  tradeSizeSol: number,
  maxSlippageBps: number,
): SafetyCheck {
  if (solReserves <= 0 || tokenReserves <= 0 || tradeSizeSol <= 0) {
    return { ok: false, reason: 'pool_reserves_invalid' };
  }
  const solInLamports = BigInt(Math.floor(tradeSizeSol * 1e9));
  const solReservesLamports = BigInt(Math.floor(solReserves * 1e9));
  const tokenReservesRaw = BigInt(Math.floor(tokenReserves * 1e6));
  const baseOut = computeExpectedBaseOut(solReservesLamports, tokenReservesRaw, solInLamports);
  if (baseOut === 0n) {
    return { ok: false, reason: 'zero_quote_output' };
  }
  // Effective price (lamports per raw token unit) vs spot price. Slippage is
  // the % difference — how much worse our fill is than the current spot.
  const effectivePriceLamportsPerToken = Number(solInLamports) / Number(baseOut);
  const spotPriceLamportsPerToken = solReserves * 1e9 / (tokenReserves * 1e6);
  const slippagePct = (effectivePriceLamportsPerToken / spotPriceLamportsPerToken - 1) * 100;
  const slippageBps = slippagePct * 100;
  if (slippageBps > maxSlippageBps) {
    return {
      ok: false,
      reason: `slippage_exceeds_ceiling: ${slippageBps.toFixed(0)}bps > ${maxSlippageBps}bps`,
      value: slippageBps,
    };
  }
  return { ok: true, value: slippageBps };
}

/**
 * Aggregate preflight for live modes. Runs all checks in order and returns
 * the first failure. For paper/shadow, only killswitch + global daily
 * circuit breaker run.
 *
 * Order:
 *   1. Killswitch        (all modes)
 *   2. Daily circuit     (all modes — protects shadow data collection too)
 *   3. Per-strategy risk (live modes only — rolling-drawdown breaker)
 *   4. Wallet balance    (live modes only)
 *   5. Slippage ceiling  (live modes only)
 *
 * Daily circuit breaker applies to all modes (including shadow/paper) so a
 * tripped day halts shadow-mode data collection too — we don't want to
 * continue pretend-trading when real losses have already maxed out.
 *
 * The per-strategy risk halt is live-only by design: a paper/shadow strategy
 * is still in research and shouldn't auto-disable from simulated losses.
 * When the breaker trips the strategy is auto-disabled via setStrategyRiskHalt
 * by StrategyManager.safetyTick — this preflight just reports the failure so
 * a stray entry attempt between safetyTick cycles can't slip through.
 */
export async function runEntryPreflight(args: {
  db: Database.Database;
  strategyId: string;
  executionMode: ExecutionMode;
  riskHaltLastNTrades?: number;
  riskHaltMaxDrawdownSol?: number;
  wallet?: Wallet | null;
  connection: Connection;
  tradeSizeSol: number;
  solReserves: number;
  tokenReserves: number;
  maxSlippageBps: number;
}): Promise<SafetyCheck> {
  if (isKillswitchTripped()) {
    return { ok: false, reason: 'killswitch' };
  }
  const cb = checkCircuitBreaker(args.db);
  if (!cb.ok) return cb;
  const riskHalt = checkStrategyRiskHalt(args.db, {
    strategyId: args.strategyId,
    executionMode: args.executionMode,
    riskHaltLastNTrades: args.riskHaltLastNTrades,
    riskHaltMaxDrawdownSol: args.riskHaltMaxDrawdownSol,
  });
  if (!riskHalt.ok) return riskHalt;
  if (args.executionMode === 'paper' || args.executionMode === 'shadow') {
    return { ok: true };
  }
  if (!args.wallet) {
    return { ok: false, reason: 'no_wallet_loaded' };
  }
  const balance = await checkWalletBalance(args.wallet, args.connection, args.tradeSizeSol);
  if (!balance.ok) return balance;
  const slip = checkExpectedSlippage(
    args.solReserves,
    args.tokenReserves,
    args.tradeSizeSol,
    args.maxSlippageBps,
  );
  if (!slip.ok) return slip;
  return { ok: true };
}

/** Log a killswitch trip once per process minute so the log isn't spammed. */
let lastKillswitchLogAt = 0;
export function maybeLogKillswitchTripped(): void {
  const now = Date.now();
  if (now - lastKillswitchLogAt > 60_000) {
    lastKillswitchLogAt = now;
    logger.warn('Killswitch active — new entries blocked, open live positions will be force-closed');
  }
}
