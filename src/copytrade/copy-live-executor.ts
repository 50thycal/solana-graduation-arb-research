import type Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { Executor, PoolContext, ExecutionResult } from '../trading/executor';
import { Wallet } from '../trading/wallet';
import { isKillswitchTripped } from '../trading/safety';
import { MICRO_TRADE_SIZE_SOL, DAILY_MAX_LOSS_SOL, WALLET_SOL_BUFFER } from '../trading/config';
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

  /** Submit a real micro buy. Caller persists the row first (crash-safety). */
  async buy(mint: string, poolCtx: PoolContext, expectedPrice: number): Promise<ExecutionResult> {
    if (!this.executor) return { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: 'no_executor' };
    // amount is hard-overridden to MICRO_TRADE_SIZE_SOL by the executor in live_micro.
    return this.executor.buy(mint, MICRO_TRADE_SIZE_SOL, expectedPrice, undefined, poolCtx, 'live_micro');
  }

  /** Submit a real sell of the held tokens. */
  async sell(mint: string, tokensHeld: number, poolCtx: PoolContext, expectedPrice: number): Promise<ExecutionResult> {
    if (!this.executor) return { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: 'no_executor' };
    return this.executor.sell(mint, tokensHeld, expectedPrice, undefined, poolCtx, 'live_micro');
  }
}
