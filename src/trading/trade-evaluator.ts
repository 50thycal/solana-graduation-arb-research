import Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';
import { TradingConfig } from './config';
import { runFilterPipeline } from './filter-pipeline';
import { TradeLogger } from './trade-logger';
import { Executor } from './executor';
import { PositionManager, ActivePosition } from './position-manager';
import { ObservationContext } from '../collector/price-collector';

const logger = makeLogger('trade-evaluator');

export class TradeEvaluator {
  private strategyId: string;

  constructor(
    private db: Database.Database,
    private config: TradingConfig,
    private tradeLogger: TradeLogger,
    private executor: Executor,
    private positionManager: PositionManager,
    strategyId: string = 'default',
  ) {
    this.strategyId = strategyId;
  }

  /** Hot-swap config without replacing the evaluator instance */
  updateConfig(config: TradingConfig): void {
    this.config = config;
  }

  /**
   * Called at T+30 after graduation_momentum row is fully written.
   * Fire-and-forget from PriceCollector — must not throw.
   *
   * Data available at this point:
   *   - pctT30, priceT30, solReserves: live from price-collector snapshot
   *   - graduation_momentum row: all T+30 metrics (velocity, age, holders,
   *     liquidity, volatility, monotonicity, drawdown, acceleration, early_vs_late)
   *   - NOT available: buy_pressure_* (written at T+35)
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
    });

    // ── 6. Execute entry ─────────────────────────────────────────────────────
    let entryResult;
    try {
      entryResult = await this.executor.buy(ctx.mint, cfg.tradeSizeSol, priceT30);
    } catch (err) {
      this.tradeLogger.failTrade(tradeId, `buy_exception: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!entryResult.success) {
      this.tradeLogger.failTrade(tradeId, `buy_failed: ${entryResult.errorMessage ?? 'unknown'}`);
      return;
    }

    // Persist the actual fill price + tokens received onto the trade row.
    // This replaces the placeholder value written at insert time so dashboards
    // and restart-recovery see the true (slippage-adjusted) entry price.
    this.tradeLogger.recordEntryFill(
      tradeId,
      entryResult.effectivePrice,
      entryResult.tokensReceived,
      entryResult.txSignature,
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
      mode: cfg.mode,
      // graduationTimestamp from ObservationContext — used by match_collection
      // mode to align price checks with SNAPSHOT_SCHEDULE offsets.
      graduationDetectedAt: ctx.graduationTimestamp,
      // Dynamic monitoring runtime state — initialized at entry
      highWaterMark: effectiveEntry,
      trailingSlActive: false,
      tpThresholdHit: false,
      postTpHighWaterMark: 0,
      effectiveSlPriceSol: slPriceSol,
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
