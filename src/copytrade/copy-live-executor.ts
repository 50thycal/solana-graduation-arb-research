import type Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { Executor, PoolContext, ExecutionResult } from '../trading/executor';
import { Wallet, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../trading/wallet';
import { isKillswitchTripped } from '../trading/safety';
import { MICRO_TRADE_SIZE_SOL, DAILY_MAX_LOSS_SOL, WALLET_SOL_BUFFER } from '../trading/config';
import { MAX_BUY_ATTEMPTS, buySlippageBpsForAttempt, buyTipMultiplierForAttempt } from '../trading/buy-retry';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copy-live-executor');

/**
 * Real-money execution wrapper for live-micro copy trades. The CopyTrader is
 * shadow-only by default; a strategy flagged executionMode='live_micro' routes
 * its entry/exit through HERE to submit real swaps via the shared Executor.
 *
 * SAFETY MODEL — merging this code does NOT start live trading:
 *   - Hard gate: COPY_LIVE_ENABLED=true AND a wallet (WALLET_PRIVATE_KEY) must
 *     both be present. Otherwise isLive() is false and the CopyTrader runs the
 *     "live" strategy as a normal shadow (logged once). Going live is a
 *     deliberate env flip the operator makes, reviewed first.
 *   - Size is hard-capped: the Executor overrides any amount to
 *     MICRO_TRADE_SIZE_SOL (0.05) in live_micro mode — a strategy can never
 *     trade more than micro size regardless of config.
 *   - Per-buy preflight: killswitch file/env, a COPY-SPECIFIC daily-loss circuit
 *     breaker (copy live trades land in copy_trades, NOT trades_v2, so the
 *     T+30 breaker can't see them), and a wallet-balance check.
 */
export class CopyLiveExecutor {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private readonly wallet: Wallet | null;
  private readonly executor: Executor | null;
  private readonly enabled: boolean;
  private warnedDisabled = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
    this.wallet = Wallet.fromEnv();
    const flag = process.env.COPY_LIVE_ENABLED === 'true';
    this.enabled = flag && this.wallet != null;
    this.executor = this.wallet ? new Executor('live_micro', opts.getConnection(), this.wallet) : null;
    if (flag && !this.wallet) {
      logger.warn('COPY_LIVE_ENABLED=true but no WALLET_PRIVATE_KEY — live-micro copy strategies will run as SHADOW.');
    } else if (this.enabled) {
      logger.warn('COPY_LIVE_ENABLED=true — live-micro copy strategies will submit REAL %s SOL swaps.', MICRO_TRADE_SIZE_SOL);
    }
  }

  /** Whether real live execution is active. When false, the CopyTrader falls back
   *  to shadowing any live_micro strategy (no real funds). */
  isLive(): boolean {
    if (!this.enabled && !this.warnedDisabled) {
      logger.info('Copy live execution OFF (COPY_LIVE_ENABLED!=true or no wallet) — live_micro strategies shadowed.');
      this.warnedDisabled = true;
    }
    return this.enabled;
  }

  /** Full snapshot of the wallet's SPL token balances for position reconciliation
   *  — mint(base58) -> raw u64 amount, non-zero only, across BOTH the standard
   *  Token and Token-2022 programs. Returns NULL when it can't be determined
   *  (live off, no wallet/connection, or an RPC failure); the caller MUST treat
   *  null as "unknown" and skip reconciliation rather than assume the wallet is
   *  empty. One snapshot answers every open position AND surfaces orphan mints in
   *  a fixed 2 RPC calls regardless of how many positions are open. A mint absent
   *  from a SUCCESSFUL snapshot is authoritatively zero (no/empty token account). */
  async walletTokenBalances(): Promise<Map<string, number> | null> {
    if (!this.enabled || !this.wallet) return null;
    const conn = this.getConnection();
    if (!conn) return null;
    try {
      const out = new Map<string, number>();
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        await globalRpcLimiter.throttle();
        const res = await conn.getParsedTokenAccountsByOwner(this.wallet.pubkey, { programId });
        for (const { account } of res.value) {
          const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } })?.parsed?.info;
          const mint = info?.mint;
          const rawStr = info?.tokenAmount?.amount;
          if (!mint || rawStr == null) continue;
          const raw = Number(rawStr);
          if (Number.isFinite(raw) && raw > 0) out.set(mint, (out.get(mint) ?? 0) + raw);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Sum net_sol of CLOSED live_micro copy trades in the current UTC day. */
  dailyLiveNetSol(): number {
    try {
      const now = new Date();
      const startSec = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(net_sol), 0) AS pnl FROM copy_trades
        WHERE status = 'closed' AND execution_mode = 'live_micro' AND exit_ts >= ? AND net_sol IS NOT NULL
      `).get(startSec) as { pnl: number };
      return Number(row?.pnl ?? 0);
    } catch { return 0; }
  }

  /** Preflight gate run before every live buy. Returns null if clear, else a reason. */
  async preflightBuy(): Promise<string | null> {
    if (isKillswitchTripped()) return 'killswitch';
    const dayPnl = this.dailyLiveNetSol();
    if (dayPnl <= -DAILY_MAX_LOSS_SOL) return `daily_loss_cap ${dayPnl.toFixed(3)} <= -${DAILY_MAX_LOSS_SOL}`;
    const conn = this.getConnection();
    if (!conn || !this.wallet) return 'no_connection_or_wallet';
    try {
      const lamports = await this.wallet.getSolBalance(conn);
      const sol = lamports / 1e9;
      if (sol < MICRO_TRADE_SIZE_SOL + WALLET_SOL_BUFFER) return `insufficient_balance ${sol.toFixed(4)}`;
    } catch (err) {
      return `balance_check_failed ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }

  /** Submit a real micro buy. Caller persists the row first (crash-safety).
   *
   *  Drives the SHARED 3-attempt retry schedule (`buy-retry.ts`) — identical to
   *  the main trading path (`trade-evaluator`). Pre-2026-06-19 this fired ONCE,
   *  so any Custom 6004 / InsufficientFundsForRent / tx-didn't-land failure
   *  terminally failed the copy buy; live_buy_failed was ~41% of closed live
   *  trades. Attempts 2-3 bump the Jito tip and widen slippage to salvage those.
   *  Size is hard-capped to MICRO_TRADE_SIZE_SOL on EVERY attempt (the executor
   *  re-overrides it in live_micro), so retries can never increase exposure. A
   *  thrown exception is terminal (no retry) — mirrors the main path.
   *
   *  IMPORTANT — what retries can and CANNOT fix (resolved 2026-06-22, see the
   *  `lesson-live-rent-buy-failures-are-balance-not-retry` lesson in report.json):
   *  the slippage+tip escalation only salvages the slippage-6004 / not-landed
   *  class. It does NOT fix 'rent' (InsufficientFundsForRent) failures — retrying
   *  adds no lamports. Rent is the DOMINANT live-buy failure class (131 of 134 at
   *  resolution) and is a wallet-balance SYMPTOM: it fires when the wallet sits
   *  near/below the preflight floor (MICRO_TRADE_SIZE_SOL + WALLET_SOL_BUFFER)
   *  with no headroom for the new-token ATA rent (~0.002) + fees + Jito tip.
   *  A climbing `failure_reasons.rent` count means fund the wallet / widen
   *  WALLET_SOL_BUFFER — it is never a retry-logic regression. */
  async buy(mint: string, poolCtx: PoolContext, expectedPrice: number): Promise<ExecutionResult> {
    if (!this.executor) return { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: 'no_executor' };
    let result: ExecutionResult | undefined;
    let lastErr = 'unknown';
    for (let attempt = 1; attempt <= MAX_BUY_ATTEMPTS; attempt++) {
      const slippageBpsOverride = buySlippageBpsForAttempt(attempt);
      const jitoTipMultiplier = buyTipMultiplierForAttempt(attempt);
      try {
        // amount is hard-overridden to MICRO_TRADE_SIZE_SOL by the executor in live_micro.
        result = await this.executor.buy(
          mint, MICRO_TRADE_SIZE_SOL, expectedPrice, undefined, poolCtx, 'live_micro',
          { slippageBpsOverride, jitoTipMultiplier, attemptNumber: attempt },
        );
      } catch (err) {
        // Exception (code bug, malformed pool, …) — don't retry, surface it.
        lastErr = err instanceof Error ? err.message : String(err);
        return { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: `buy_exception: ${lastErr}` };
      }
      if (result.success) return result;
      lastErr = result.errorMessage ?? 'unknown';
      if (attempt < MAX_BUY_ATTEMPTS) {
        logger.warn(
          'Copy LIVE buy attempt %d/%d failed for %s (slip %d bps, tip %d×): %s — retrying',
          attempt, MAX_BUY_ATTEMPTS, mint.slice(0, 6), slippageBpsOverride, jitoTipMultiplier, lastErr,
        );
      }
    }
    // All attempts exhausted — return the last failed result, tagging the
    // errorMessage so the persisted live_error reflects the retry exhaustion.
    return {
      ...(result ?? { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false }),
      success: false,
      errorMessage: `buy_failed_after_${MAX_BUY_ATTEMPTS}_attempts: ${lastErr}`,
    };
  }

  /** Submit a real sell of the held tokens. `retryOverrides` drives the shared
   *  escalating-slippage + tip-bump schedule (`sell-retry.ts`) per attempt — the
   *  caller (`copy-trader.closeLivePosition`) spreads attempts across poll ticks
   *  and tracks the attempt number on the position. Pre-2026-06-19 this forwarded
   *  no overrides, so the executor always used default slippage and a reverting
   *  sell (Custom 6053 / 6004) could never widen out of the failure. */
  async sell(
    mint: string,
    tokensHeld: number,
    poolCtx: PoolContext,
    expectedPrice: number,
    retryOverrides?: { slippageBpsOverride?: number; jitoTipMultiplier?: number; attemptNumber?: number },
  ): Promise<ExecutionResult> {
    if (!this.executor) return { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: 'no_executor' };
    return this.executor.sell(mint, tokensHeld, expectedPrice, undefined, poolCtx, 'live_micro', retryOverrides);
  }
}
