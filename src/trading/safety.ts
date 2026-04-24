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
  type ExecutionMode,
} from './config';
import { computeExpectedBaseOut } from './pumpswap-swap';
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
 * Aggregate preflight for live modes. Runs all 4 checks in order and returns
 * the first failure. For paper/shadow, only killswitch + circuit breaker run.
 *
 * Circuit breaker applies to all modes (including shadow/paper) so a tripped
 * day halts shadow-mode data collection too — we don't want to continue
 * pretend-trading when real losses have already maxed out.
 */
export async function runEntryPreflight(args: {
  db: Database.Database;
  executionMode: ExecutionMode;
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
