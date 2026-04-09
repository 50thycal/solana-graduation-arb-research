import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { loadTradingConfig, describeTradingConfig, TradingConfig } from './config';
import { TradeLogger } from './trade-logger';
import { Executor } from './executor';
import { PositionManager, ExitEvent } from './position-manager';
import { TradeEvaluator } from './trade-evaluator';
import { PriceCollector, ObservationContext } from '../collector/price-collector';
import { getOpenTrades } from '../db/queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-engine');

const BACKFILL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class TradingEngine {
  private config: TradingConfig;
  private tradeLogger: TradeLogger;
  private executor: Executor;
  private positionManager: PositionManager;
  private evaluator: TradeEvaluator;
  private backfillTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private connection: Connection,
  ) {
    this.config = loadTradingConfig();
    this.tradeLogger = new TradeLogger(db);
    this.executor = new Executor(this.config.mode);
    this.positionManager = new PositionManager();
    this.evaluator = new TradeEvaluator(
      db,
      this.config,
      this.tradeLogger,
      this.executor,
      this.positionManager,
    );

    // Wire position exits → close trade in DB
    this.positionManager.on('exit', (event: ExitEvent) => {
      this.handleExit(event).catch(err => {
        logger.error(
          'Exit handler error for trade %d: %s',
          event.position.tradeId,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
  }

  /**
   * Initialize — recover any open trades from a previous process run,
   * start the position monitor, and kick off the backfill timer.
   */
  initialize(): void {
    if (!this.config.enabled) {
      logger.info('Trading disabled (TRADING_ENABLED != true)');
      return;
    }

    logger.info('TradingEngine initializing: %s', describeTradingConfig(this.config));

    // Recover open positions surviving a process restart
    this.recoverOpenPositions();

    this.positionManager.start(this.connection);

    // Periodically backfill momentum comparison fields on closed trades
    this.backfillTimer = setInterval(() => {
      this.tradeLogger.backfillMomentum();
    }, BACKFILL_INTERVAL_MS);

    // Run once at startup to catch any stale open trades
    this.tradeLogger.backfillMomentum();
  }

  /**
   * Attach this engine to a PriceCollector so it receives the T+30 callback.
   * Must be called after initialize().
   */
  attachToPriceCollector(priceCollector: PriceCollector): void {
    if (!this.config.enabled) return;

    priceCollector.setT30Callback(
      (graduationId: number, ctx: ObservationContext, priceT30: number, pctT30: number, solReserves: number) => {
        this.evaluator.onT30(graduationId, ctx, priceT30, pctT30, solReserves).catch(err => {
          logger.error(
            'TradeEvaluator.onT30 error for grad %d: %s',
            graduationId,
            err instanceof Error ? err.message : String(err)
          );
        });
      }
    );

    logger.info('Attached to PriceCollector T+30 callback');
  }

  /** Update connection reference when RPC reconnects */
  updateConnection(connection: Connection): void {
    this.connection = connection;
    this.positionManager.updateConnection(connection);
  }

  stop(): void {
    this.positionManager.stop();
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer);
      this.backfillTimer = null;
    }
  }

  getConfig(): TradingConfig {
    return this.config;
  }

  getStats() {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      activePositions: this.positionManager.activeCount(),
      activePositionDetails: this.positionManager.getPositions().map(p => ({
        tradeId: p.tradeId,
        mint: p.mint,
        entryPriceSol: p.entryPriceSol,
        tpPriceSol: p.tpPriceSol,
        slPriceSol: p.slPriceSol,
        secondsHeld: Math.floor(Date.now() / 1000) - p.entryTimestamp,
        maxHoldSeconds: p.maxExitTimestamp - p.entryTimestamp,
      })),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async handleExit(event: ExitEvent): Promise<void> {
    const { position: pos, exitReason, exitPriceSol } = event;

    // Execute sell (paper: no-op, live: Jupiter)
    let sellResult;
    try {
      sellResult = await this.executor.sell(pos.mint, pos.tokensHeld, exitPriceSol);
    } catch (err) {
      logger.error({ tradeId: pos.tradeId }, 'Sell execution threw: %s', err instanceof Error ? err.message : String(err));
      sellResult = { success: true, effectivePrice: exitPriceSol, tokensReceived: 0, dryRun: pos.mode === 'paper' };
    }

    const effectiveExitPrice = sellResult.effectivePrice ?? exitPriceSol;

    this.tradeLogger.closeTrade({
      tradeId: pos.tradeId,
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol: effectiveExitPrice,
      exitReason,
      tradeSizeSol: this.config.tradeSizeSol,
      takeProfitPct: this.config.takeProfitPct,
      stopLossPct: this.config.stopLossPct,
      slGapPenaltyPct: this.config.slGapPenaltyPct,
      tpGapPenaltyPct: this.config.tpGapPenaltyPct,
      exitTxSignature: sellResult.txSignature,
    });
  }

  /**
   * Re-register any open trade rows as monitored positions after a process restart.
   * Paper mode: positions are marked as TIMEOUT immediately (price is stale).
   * Live mode: re-register for continued SL/TP monitoring.
   */
  private recoverOpenPositions(): void {
    const openTrades = getOpenTrades(this.db) as any[];
    if (openTrades.length === 0) return;

    logger.info({ count: openTrades.length }, 'Recovering open positions from DB');

    for (const trade of openTrades) {
      if (trade.mode === 'paper') {
        // Paper positions can't be reliably recovered — mark as timeout
        this.tradeLogger.closeTrade({
          tradeId: trade.id,
          entryPriceSol: trade.entry_price_sol,
          exitPriceSol: trade.entry_price_sol, // unknown — use entry as fallback
          exitReason: 'timeout',
          tradeSizeSol: trade.trade_size_sol,
          takeProfitPct: trade.take_profit_pct,
          stopLossPct: trade.stop_loss_pct,
          slGapPenaltyPct: this.config.slGapPenaltyPct,
          tpGapPenaltyPct: this.config.tpGapPenaltyPct,
        });
        logger.info({ tradeId: trade.id }, 'Recovered paper position → closed as timeout');
        continue;
      }

      // Live mode: re-register if vaults are available
      if (!trade.base_vault || !trade.quote_vault) {
        this.tradeLogger.failTrade(trade.id, 'recovery_no_vaults');
        continue;
      }

      const entryPrice = trade.entry_effective_price ?? trade.entry_price_sol;
      this.positionManager.addPosition({
        tradeId: trade.id,
        graduationId: trade.graduation_id,
        mint: trade.mint,
        poolAddress: trade.pool_address,
        baseVault: trade.base_vault,
        quoteVault: trade.quote_vault,
        entryPriceSol: entryPrice,
        entryTimestamp: trade.entry_timestamp,
        tpPriceSol: entryPrice * (1 + trade.take_profit_pct / 100),
        slPriceSol: entryPrice * (1 - trade.stop_loss_pct / 100),
        maxExitTimestamp: trade.entry_timestamp + trade.max_hold_seconds,
        tokensHeld: trade.entry_tokens_received ?? 0,
        mode: 'live',
      });
      logger.info({ tradeId: trade.id }, 'Live position recovered for monitoring');
    }
  }
}
