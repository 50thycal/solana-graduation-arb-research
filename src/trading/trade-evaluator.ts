import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { makeLogger } from '../utils/logger';
import { TradingConfig, DEFAULT_MAX_SLIPPAGE_BPS, MICRO_TRADE_SIZE_SOL, isHourInUtcWindow, SWAP_SLIPPAGE_BPS } from './config';
import { runFilterPipeline } from './filter-pipeline';
import { getCurrentRegime } from '../api/regime-analysis';
import { TradeLogger } from './trade-logger';
import { Executor } from './executor';
import { getMintProfile } from './token-2022';
import { PositionManager, ActivePosition } from './position-manager';
import { ObservationContext } from '../collector/price-collector';
import { runEntryPreflight, maybeLogKillswitchTripped, isKillswitchTripped } from './safety';
import { resolvePoolFromVault } from './pool-resolver';
import type { Wallet } from './wallet';

const logger = makeLogger('trade-evaluator');

/** Live-buy retry schedule (2026-05-27).
 *
 *  Pre-fix: single attempt — any failure (Custom 6004 / InsufficientFundsForRent)
 *  immediately marked the trade failed. Observed ~20 buy failures in last week
 *  on live_micro: ~60% rent issues, ~40% slippage (Custom 6004 from price drift
 *  during tx_land). Most could be salvaged with a retry at higher tip and/or
 *  wider slippage.
 *
 *  New schedule — 3 attempts max (entry timing is critical, can't burn too
 *  long retrying or we enter late on a moving token):
 *
 *    Attempt 1: SWAP_SLIPPAGE_BPS, 1× tip — normal entry (most trades succeed)
 *    Attempt 2: SWAP_SLIPPAGE_BPS, 5× tip — bump Jito priority for faster land
 *    Attempt 3: 2× SWAP_SLIPPAGE_BPS (capped at 2000 bps), 5× tip — widen
 *               slippage room; last shot before terminal fail
 *
 *  After attempt 3 fails, mark trade as failed with buy_failed_after_3_attempts.
 *  The buy retry is shorter than the sell retry (3 vs 9) because late entries
 *  on fast-moving graduations are worse than no entry — we can't widen slippage
 *  too far without making bad entries. */
const MAX_BUY_ATTEMPTS = 3;
const BUY_MAX_SLIPPAGE_BPS = 2000;  // 20% absolute cap on attempt-3 slippage

function buySlippageBpsForAttempt(attemptNumber: number): number {
  if (attemptNumber <= 2) return SWAP_SLIPPAGE_BPS;
  return Math.min(SWAP_SLIPPAGE_BPS * 2, BUY_MAX_SLIPPAGE_BPS);
}
function buyTipMultiplierForAttempt(attemptNumber: number): number {
  return attemptNumber === 1 ? 1 : 5;
}

export class TradeEvaluator {
  private strategyId: string;
  private markovFilterKey: string | undefined;

  constructor(
    private db: Database.Database,
    private config: TradingConfig,
    private tradeLogger: TradeLogger,
    private executor: Executor,
    private positionManager: PositionManager,
    strategyId: string = 'default',
    private connection: Connection | null = null,
    private wallet: Wallet | null = null,
  ) {
    this.strategyId = strategyId;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  /** Hot-swap config without replacing the evaluator instance */
  updateConfig(config: TradingConfig): void {
    this.config = config;
  }

  /** StrategyManager calls this on create + filter-change so each new position
   *  carries the correct matrix-lookup key. */
  setMarkovFilterKey(key: string): void {
    this.markovFilterKey = key;
  }

  /**
   * Called at T+30 after graduation_momentum row is fully written.
   * Fire-and-forget from PriceCollector — must not throw.
   *
   * Data available at this point:
   *   - pctT30, priceT30, solReserves: live from price-collector snapshot
   *   - graduation_momentum row: all T+30 metrics (velocity, age, holders,
   *     liquidity, volatility, monotonicity, drawdown, acceleration, early_vs_late)
   *   - buy_pressure_* fields: available if strategy uses buy_pressure filters
   *     (StrategyManager auto-delays evaluation to T+35)
   */
  async onT30(
    graduationId: number,
    ctx: ObservationContext,
    priceT30: number,
    pctT30: number,
    solReserves: number,
  ): Promise<void> {
    // Snapshot config to avoid race conditions if config is hot-swapped mid-evaluation
    const cfg = this.config;

    // ── 1. Entry gate ────────────────────────────────────────────────────────
    if (pctT30 < cfg.entryGateMinPctT30 || pctT30 > cfg.entryGateMaxPctT30) {
      this.tradeLogger.logSkipped(graduationId, 'entry_gate', pctT30, pctT30, this.strategyId);
      logger.debug(
        { graduationId, pctT30: pctT30.toFixed(1), strategy: this.strategyId },
        'Entry gate failed'
      );
      return;
    }

    // ── 1b. Time-of-day gate (optional, UTC) ────────────────────────────────
    if (cfg.entryHourUtcMin != null && cfg.entryHourUtcMax != null) {
      const hour = new Date().getUTCHours();
      if (!isHourInUtcWindow(hour, cfg.entryHourUtcMin, cfg.entryHourUtcMax)) {
        this.tradeLogger.logSkipped(graduationId, 'time_gate', hour, pctT30, this.strategyId);
        logger.debug(
          { graduationId, hour, window: `${cfg.entryHourUtcMin}-${cfg.entryHourUtcMax}`, strategy: this.strategyId },
          'Time-of-day gate blocked entry'
        );
        return;
      }
    }

    // ── 1c. Market-regime gate (optional, uses market_daily) ────────────────
    // Apply only if at least one of the six bounds is set. Query today's UTC
    // date once and check SOL / BTC return % and F&G value against the
    // strategy's allowed ranges. Permissive on missing market_daily row —
    // we'd rather trade than blackhole during a fetcher hiccup.
    const hasMarketGate =
      cfg.entrySolReturnPctMin != null || cfg.entrySolReturnPctMax != null
      || cfg.entryBtcReturnPctMin != null || cfg.entryBtcReturnPctMax != null
      || cfg.entryFngValueMin != null || cfg.entryFngValueMax != null;
    if (hasMarketGate) {
      const todayUtc = new Date().toISOString().slice(0, 10);
      const mr = this.db.prepare(`
        SELECT sol_usd_open, sol_usd_close, btc_usd_open, btc_usd_close, fear_greed_value
        FROM market_daily WHERE date = ?
      `).get(todayUtc) as {
        sol_usd_open: number | null;
        sol_usd_close: number | null;
        btc_usd_open: number | null;
        btc_usd_close: number | null;
        fear_greed_value: number | null;
      } | undefined;

      if (!mr) {
        logger.warn(
          { graduationId, strategy: this.strategyId, date: todayUtc },
          'market_daily missing for today — market-regime gate is permissive, allowing entry'
        );
      } else {
        const solRet = (mr.sol_usd_open != null && mr.sol_usd_close != null && mr.sol_usd_open > 0)
          ? ((mr.sol_usd_close - mr.sol_usd_open) / mr.sol_usd_open) * 100
          : null;
        const btcRet = (mr.btc_usd_open != null && mr.btc_usd_close != null && mr.btc_usd_open > 0)
          ? ((mr.btc_usd_close - mr.btc_usd_open) / mr.btc_usd_open) * 100
          : null;
        const fng = mr.fear_greed_value;

        const outOfRange = (v: number | null, min: number | undefined, max: number | undefined): boolean => {
          if (v == null) return false;  // missing data = permissive
          if (min != null && v < min) return true;
          if (max != null && v > max) return true;
          return false;
        };
        if (outOfRange(solRet, cfg.entrySolReturnPctMin, cfg.entrySolReturnPctMax)) {
          this.tradeLogger.logSkipped(graduationId, 'market_gate_sol', solRet, pctT30, this.strategyId);
          logger.debug({ graduationId, solRet, strategy: this.strategyId }, 'SOL-return gate blocked entry');
          return;
        }
        if (outOfRange(btcRet, cfg.entryBtcReturnPctMin, cfg.entryBtcReturnPctMax)) {
          this.tradeLogger.logSkipped(graduationId, 'market_gate_btc', btcRet, pctT30, this.strategyId);
          logger.debug({ graduationId, btcRet, strategy: this.strategyId }, 'BTC-return gate blocked entry');
          return;
        }
        if (outOfRange(fng, cfg.entryFngValueMin, cfg.entryFngValueMax)) {
          this.tradeLogger.logSkipped(graduationId, 'market_gate_fng', fng, pctT30, this.strategyId);
          logger.debug({ graduationId, fng, strategy: this.strategyId }, 'F&G gate blocked entry');
          return;
        }
      }
    }

    // ── 1d. PumpFun-tape regime gate (optional, uses getCurrentRegime) ──────
    // skip_red   → block when current regime is RED.
    // green_only → block unless current regime is GREEN.
    // Permissive (allow) when the regime can't be classified yet (warmup), same
    // as the market_daily gate above — we'd rather trade than blackhole.
    if (cfg.regimeGate) {
      const rg = getCurrentRegime(this.db);
      if (rg == null) {
        logger.debug(
          { graduationId, strategy: this.strategyId, gate: cfg.regimeGate },
          'regime gate permissive — not enough complete grads to classify',
        );
      } else {
        const blocked =
          (cfg.regimeGate === 'skip_red' && rg.regime === 'RED') ||
          (cfg.regimeGate === 'green_only' && rg.regime !== 'GREEN');
        if (blocked) {
          this.tradeLogger.logSkipped(graduationId, `regime_gate_${cfg.regimeGate}`, null, pctT30, this.strategyId);
          logger.debug(
            { graduationId, strategy: this.strategyId, gate: cfg.regimeGate, regime: rg.regime, nWindow: rg.nWindow },
            'Regime gate blocked entry',
          );
          return;
        }
      }
    }

    // ── 2. Capacity check ────────────────────────────────────────────────────
    if (this.positionManager.activeCount() >= cfg.maxConcurrentPositions) {
      this.tradeLogger.logSkipped(graduationId, 'max_positions', this.positionManager.activeCount(), pctT30, this.strategyId);
      logger.debug({ graduationId, activePositions: this.positionManager.activeCount(), strategy: this.strategyId }, 'Max positions reached');
      return;
    }

    // ── 3. Read graduation_momentum row (synchronous SQLite) ─────────────────
    const row = this.db.prepare(
      'SELECT * FROM graduation_momentum WHERE graduation_id = ?'
    ).get(graduationId) as Record<string, unknown> | undefined;

    if (!row) {
      this.tradeLogger.logSkipped(graduationId, 'no_momentum_row', null, pctT30, this.strategyId);
      logger.warn({ graduationId, strategy: this.strategyId }, 'No graduation_momentum row at T+30');
      return;
    }

    // ── 4. Filter pipeline ───────────────────────────────────────────────────
    const filterResult = runFilterPipeline(row, cfg.filters);
    if (!filterResult.passed) {
      this.tradeLogger.logSkipped(
        graduationId,
        `filter:${filterResult.failedFilter}`,
        filterResult.failedValue,
        pctT30,
        this.strategyId,
      );
      logger.debug(
        { graduationId, failedFilter: filterResult.failedFilter, failedValue: filterResult.failedValue },
        'Filter pipeline failed'
      );
      return;
    }

    // ── 4b. Safety preflight (killswitch + circuit breaker + balance + slippage) ──
    //
    // For live_micro the executor hard-overrides amountSol to MICRO_TRADE_SIZE_SOL
    // (see executor.ts:206). The safety preflight must use the SAME effective size
    // or it'll reject live_micro entries against the strategy's configured
    // tradeSizeSol — a strategy with tradeSizeSol=0.5 in live_micro mode needs
    // only 0.05+buffer SOL in the wallet, not 0.5+buffer. 2026-05-21 bug fix.
    const executionMode = cfg.executionMode;
    const effectiveTradeSize = executionMode === 'live_micro'
      ? MICRO_TRADE_SIZE_SOL
      : cfg.tradeSizeSol;

    // Validate the pool address for live entries. The listener stores a
    // synthetic placeholder of the form `vaults:<base8>` when it couldn't
    // extract the real PumpSwap pool PDA from the migrate tx (a known
    // upstream parsing gap). Those addresses work fine for vault-based
    // price reads (paper / shadow) but `new PublicKey("vaults:abc")` throws
    // "Non-base58 character" in the live executor.
    //
    // Resolution path (2026-05-22): when the stored address is synthetic,
    // try resolving the real PDA on-the-fly by reading the SPL Token
    // account at baseVault and pulling its `owner` field — that's the pool
    // PDA. One RPC call per cache miss, write-back to graduations table so
    // future evaluations skip the resolver. Only if resolution fails do
    // we skip with `safety:invalid_pool_address`. See pool-resolver.ts.
    const isLive = executionMode === 'live_micro' || executionMode === 'live_full';
    if (isLive && ctx.poolAddress) {
      let poolValid = false;
      try {
        new PublicKey(ctx.poolAddress);
        poolValid = true;
      } catch {
        poolValid = false;
      }
      if (!poolValid && this.connection && ctx.baseVault) {
        const resolved = await resolvePoolFromVault({
          connection: this.connection,
          mint: ctx.mint,
          baseVault: ctx.baseVault,
          graduationId,
          db: this.db,
        });
        if (resolved) {
          logger.info(
            {
              graduationId,
              mint: ctx.mint,
              strategyId: this.strategyId,
              priorPoolAddress: ctx.poolAddress,
              resolvedPoolAddress: resolved,
            },
            'Synthetic pool address resolved via baseVault.owner — live entry unblocked'
          );
          ctx.poolAddress = resolved;
          poolValid = true;
        }
      }
      if (!poolValid) {
        this.tradeLogger.logSkipped(
          graduationId,
          'safety:invalid_pool_address',
          null,
          pctT30,
          this.strategyId,
        );
        logger.info(
          {
            graduationId,
            mint: ctx.mint,
            poolAddress: ctx.poolAddress,
            hasBaseVault: !!ctx.baseVault,
            hasConnection: !!this.connection,
            strategyId: this.strategyId,
          },
          'Skipping live entry — pool address invalid and resolver failed (vault-based modes still work)'
        );
        return;
      }
    }

    // Reject live entries only on Token-2022 mints with a TransferHook
    // extension. TransferHook installs custom on-chain transfer logic and is
    // the standard honeypot pattern — the buy succeeds, then the sell hook
    // blocks the transfer and the position is stuck at 100% loss.
    //
    // Plain Token-2022 (with MetadataPointer / TransferFeeConfig / etc.) is
    // now the standard mint format, so the previous wholesale isToken2022
    // block was rejecting valid trades. Trade 11713's InsufficientFundsForRent
    // crash (the original reason the broad block was added) was actually a
    // rent-budget shortfall in our swap ix on TransferHook extension
    // accounts — TransferHook tokens reliably hit that path because of the
    // extra `extra_account_metas` PDA they require. Blocking TransferHook
    // alone removes both the rent-failure case and the honeypot risk.
    //
    // We always run the profile fetch on live mode so the mint flags are
    // available for diagnostics whether the trade fires or not.
    if (isLive && this.connection) {
      try {
        const mintProfile = await getMintProfile(this.connection, new PublicKey(ctx.mint));
        if (mintProfile.hasTransferHook) {
          this.tradeLogger.logSkipped(
            graduationId,
            'safety:transfer_hook_honeypot_risk',
            null,
            pctT30,
            this.strategyId,
          );
          logger.info(
            {
              graduationId,
              mint: ctx.mint,
              isToken2022: mintProfile.isToken2022,
              hasTransferFee: mintProfile.hasTransferFee,
              hasTransferHook: true,
              extensionTypes: mintProfile.extensionTypes,
              strategyId: this.strategyId,
            },
            'Skipping live entry — TransferHook extension present (honeypot risk: sell hook can block exit)'
          );
          return;
        }
        if (mintProfile.isToken2022) {
          logger.info(
            {
              graduationId,
              mint: ctx.mint,
              hasTransferFee: mintProfile.hasTransferFee,
              extensionTypes: mintProfile.extensionTypes,
              strategyId: this.strategyId,
            },
            'Live entry on Token-2022 mint — allowed (no TransferHook)'
          );
        }
      } catch (err) {
        // Mint profile fetch failed — log + proceed (defensive: don't block
        // entry on a transient RPC blip). The downstream executor will hit
        // the same call and fail there with a clearer error if needed.
        logger.warn(
          {
            graduationId,
            mint: ctx.mint,
            err: err instanceof Error ? err.message : String(err),
            strategyId: this.strategyId,
          },
          'getMintProfile failed in live preflight — proceeding to executor'
        );
      }
    }

    if (this.connection) {
      const preflight = await runEntryPreflight({
        db: this.db,
        executionMode,
        wallet: this.wallet,
        connection: this.connection,
        tradeSizeSol: effectiveTradeSize,
        solReserves,
        tokenReserves: solReserves / priceT30,
        maxSlippageBps: cfg.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
      });
      if (!preflight.ok) {
        if (preflight.reason === 'killswitch') maybeLogKillswitchTripped();
        this.tradeLogger.logSkipped(
          graduationId,
          `safety:${preflight.reason}`,
          preflight.value ?? null,
          pctT30,
          this.strategyId,
        );
        logger.warn(
          { graduationId, strategy: this.strategyId, reason: preflight.reason },
          'Safety preflight blocked entry'
        );
        return;
      }
    } else if (executionMode !== 'paper' && isKillswitchTripped()) {
      // Fallback killswitch check for paper-only path without connection.
      maybeLogKillswitchTripped();
      this.tradeLogger.logSkipped(graduationId, 'safety:killswitch', null, pctT30, this.strategyId);
      return;
    }

    logger.info(
      {
        graduationId,
        mint: ctx.mint,
        pctT30: pctT30.toFixed(1),
        solReserves: solReserves.toFixed(1),
        filters: filterResult.stages.map(s => `${s.label}:${s.actualValue}`).join(','),
        strategy: this.strategyId,
      },
      'Trade signal — opening position'
    );

    // ── 5. Open trade record ─────────────────────────────────────────────────
    const tradeId = this.tradeLogger.openTrade({
      graduationId,
      mint: ctx.mint,
      poolAddress: ctx.poolAddress,
      baseVault: ctx.baseVault,
      quoteVault: ctx.quoteVault,
      entryPriceSol: priceT30,
      entryPctFromOpen: pctT30,
      entryLiquiditySol: solReserves,
      filterStages: filterResult.stages,
      config: cfg,
      strategyId: this.strategyId,
      executionMode,
    });

    // ── 6. Execute entry ─────────────────────────────────────────────────────
    // Use per-token slippage estimate from graduation_momentum if available
    let slippageEstPct: number | undefined;
    if (row.slippage_est_05sol != null) {
      slippageEstPct = Number(row.slippage_est_05sol);
    }

    const poolCtx = (ctx.baseVault && ctx.quoteVault)
      ? { poolAddress: ctx.poolAddress, baseVault: ctx.baseVault, quoteVault: ctx.quoteVault }
      : undefined;

    // Live-buy retry loop (2026-05-27). Paper/shadow don't iterate — they
    // execute once. For live, run up to MAX_BUY_ATTEMPTS with the per-attempt
    // slippage/tip schedule above. On each failure, log + try the next
    // attempt; only fail the trade row if all attempts exhausted. Reuses the
    // `isLive` flag computed earlier in the entry-preflight block.
    const attemptCap = isLive ? MAX_BUY_ATTEMPTS : 1;
    let entryResult: Awaited<ReturnType<typeof this.executor.buy>> | undefined;
    let lastErrMsg = 'unknown';
    let attemptException: { message: string; stack?: string } | null = null;
    for (let attempt = 1; attempt <= attemptCap; attempt++) {
      const slippageBpsOverride = isLive ? buySlippageBpsForAttempt(attempt) : undefined;
      const tipMult = isLive ? buyTipMultiplierForAttempt(attempt) : undefined;
      try {
        entryResult = await this.executor.buy(
          ctx.mint, cfg.tradeSizeSol, priceT30, slippageEstPct, poolCtx, executionMode,
          isLive ? { slippageBpsOverride, jitoTipMultiplier: tipMult, attemptNumber: attempt } : undefined,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        attemptException = { message, stack };
        lastErrMsg = message;
        logger.error(
          { tradeId, mint: ctx.mint, mode: executionMode, attempt, stack },
          'Buy execution threw: %s', message,
        );
        // Throw is treated as a single-attempt terminal — don't retry an
        // exception (could be a code bug, malformed pool, etc).
        break;
      }
      if (entryResult.success) break;
      lastErrMsg = entryResult.errorMessage ?? 'unknown';
      if (isLive && attempt < attemptCap) {
        const nextSlip = buySlippageBpsForAttempt(attempt + 1);
        const nextTip = buyTipMultiplierForAttempt(attempt + 1);
        logger.warn(
          {
            tradeId, mint: ctx.mint, attempt, attemptCap,
            slippageBpsUsed: slippageBpsOverride,
            tipMultiplierUsed: tipMult,
            nextSlippageBps: nextSlip,
            nextTipMultiplier: nextTip,
            errorMessage: lastErrMsg,
          },
          `Live buy attempt ${attempt}/${attemptCap} failed — retrying with slip ${nextSlip} bps, tip ${nextTip}×`,
        );
      }
    }

    if (attemptException) {
      this.tradeLogger.failTrade(tradeId, `buy_exception: ${attemptException.message}`);
      return;
    }
    if (!entryResult || !entryResult.success) {
      const failReason = isLive
        ? `buy_failed_after_${attemptCap}_attempts: ${lastErrMsg}`
        : `buy_failed: ${lastErrMsg}`;
      this.tradeLogger.failTrade(tradeId, failReason, {
        txSignature: entryResult?.txSignature,
        txLandMs: entryResult?.txLandMs,
        jitoTipSol: entryResult?.jitoTipSol,
        failurePath: entryResult?.failurePath,
        mintExtensionFlags: entryResult?.mintExtensionFlags ?? null,
        failureContext: entryResult?.failureContext,
      });
      return;
    }

    // Persist the actual fill price + tokens received onto the trade row.
    // In shadow mode the tx was never submitted but we record the measured
    // slippage for paper-vs-shadow comparison.
    const isShadow = executionMode === 'shadow';
    this.tradeLogger.recordEntryFill(
      tradeId,
      entryResult.effectivePrice,
      entryResult.tokensReceived,
      entryResult.txSignature,
      {
        shadowMeasuredEntrySlippagePct: isShadow ? entryResult.measuredSlippagePct : undefined,
        jitoTipSol: entryResult.jitoTipSol,
        txLandMs: entryResult.txLandMs,
        ataRentCostSol: entryResult.ataRentCostSol,
      },
    );

    // ── 7. Register position for SL/TP monitoring ────────────────────────────
    const effectiveEntry = entryResult.effectivePrice;
    const nowSec = Math.floor(Date.now() / 1000);
    const slPriceSol = effectiveEntry * (1 - cfg.stopLossPct / 100);
    const position: ActivePosition = {
      tradeId,
      graduationId,
      mint: ctx.mint,
      poolAddress: ctx.poolAddress,
      baseVault: ctx.baseVault ?? '',
      quoteVault: ctx.quoteVault ?? '',
      entryPriceSol: effectiveEntry,
      entryTimestamp: nowSec,
      tpPriceSol: effectiveEntry * (1 + cfg.takeProfitPct / 100),
      slPriceSol,
      maxExitTimestamp: nowSec + cfg.maxHoldSeconds,
      tokensHeld: entryResult.tokensReceived,
      mode: (executionMode === 'live_micro' || executionMode === 'live_full') ? 'live' : 'paper',
      executionMode,
      // graduationTimestamp from ObservationContext — used by match_collection
      // mode to align price checks with SNAPSHOT_SCHEDULE offsets.
      graduationDetectedAt: ctx.graduationTimestamp,
      // Dynamic monitoring runtime state — initialized at entry
      highWaterMark: effectiveEntry,
      trailingSlActive: false,
      tpThresholdHit: false,
      postTpHighWaterMark: 0,
      effectiveSlPriceSol: slPriceSol,
      slippageEstPct,
      markovFilterKey: this.markovFilterKey,
    };

    if (!position.baseVault || !position.quoteVault) {
      // Vault addresses not yet resolved — we cannot monitor this position.
      // Log as failed so the trade record doesn't stay open forever.
      this.tradeLogger.failTrade(tradeId, 'no_vault_addresses');
      logger.warn({ tradeId, graduationId }, 'Cannot open position — vault addresses not available at T+30');
      return;
    }

    this.positionManager.addPosition(position);
  }
}
