import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { makeLogger } from '../utils/logger';
import { TradingConfig, DEFAULT_MAX_SLIPPAGE_BPS } from './config';
import { runFilterPipeline } from './filter-pipeline';
import { TradeLogger } from './trade-logger';
import { Executor } from './executor';
import { PositionManager, ActivePosition } from './position-manager';
import { ObservationContext } from '../collector/price-collector';
import { runEntryPreflight, maybeLogKillswitchTripped, isKillswitchTripped } from './safety';
import type { Wallet } from './wallet';

const logger = makeLogger('trade-evaluator');

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
    const executionMode = cfg.executionMode;
    if (this.connection) {
      const preflight = await runEntryPreflight({
        db: this.db,
        executionMode,
        wallet: this.wallet,
        connection: this.connection,
        tradeSizeSol: cfg.tradeSizeSol,
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

    let entryResult;
    try {
      entryResult = await this.executor.buy(
        ctx.mint, cfg.tradeSizeSol, priceT30, slippageEstPct, poolCtx, executionMode,
      );
    } catch (err) {
      this.tradeLogger.failTrade(tradeId, `buy_exception: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!entryResult.success) {
      this.tradeLogger.failTrade(tradeId, `buy_failed: ${entryResult.errorMessage ?? 'unknown'}`, {
        txSignature: entryResult.txSignature,
        txLandMs: entryResult.txLandMs,
        jitoTipSol: entryResult.jitoTipSol,
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
