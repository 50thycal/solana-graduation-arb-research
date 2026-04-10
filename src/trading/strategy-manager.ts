import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import {
  loadTradingConfig,
  describeTradingConfig,
  TradingConfig,
  StrategyParams,
  strategyParamsFromConfig,
  mergeStrategyParams,
} from './config';
import { TradeLogger } from './trade-logger';
import { Executor } from './executor';
import { PositionManager, ExitEvent } from './position-manager';
import { TradeEvaluator } from './trade-evaluator';
import { PriceCollector, ObservationContext } from '../collector/price-collector';
import {
  getStrategyConfigs,
  upsertStrategyConfig,
  deleteStrategyConfig as dbDeleteStrategy,
  getOpenTradesByStrategy,
  getOpenTrades,
  getTradeStatsByStrategy,
} from '../db/queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('strategy-manager');

const BACKFILL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface StrategyInstance {
  id: string;
  label: string;
  enabled: boolean;
  config: TradingConfig;
  evaluator: TradeEvaluator;
  positionManager: PositionManager;
}

export interface StrategyInfo {
  id: string;
  label: string;
  enabled: boolean;
  params: StrategyParams;
  activePositions: number;
}

export class StrategyManager {
  private globalConfig: TradingConfig;
  private strategies: Map<string, StrategyInstance> = new Map();
  private tradeLogger: TradeLogger;
  private executor: Executor;
  private backfillTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private connection: Connection,
  ) {
    this.globalConfig = loadTradingConfig();
    this.tradeLogger = new TradeLogger(db);
    this.executor = new Executor(this.globalConfig.mode);
  }

  initialize(): void {
    if (!this.globalConfig.enabled) {
      logger.info('Trading disabled (TRADING_ENABLED != true)');
      return;
    }

    // Load strategies from DB, seed default if empty
    const rows = getStrategyConfigs(this.db);
    if (rows.length === 0) {
      // First boot: seed 'default' strategy from env vars
      const params = strategyParamsFromConfig(this.globalConfig);
      upsertStrategyConfig(this.db, 'default', 'Default', JSON.stringify(params), 1);
      logger.info('Seeded default strategy from env vars');
      this.createInstance('default', 'Default', true, params);
    } else {
      for (const row of rows) {
        const params = JSON.parse(row.config_json) as StrategyParams;
        this.createInstance(row.id, row.label, row.enabled === 1, params);
      }
    }

    // Recover open positions from previous run
    this.recoverOpenPositions();

    // Start all position managers
    for (const instance of this.strategies.values()) {
      if (instance.enabled) {
        instance.positionManager.start(this.connection);
      }
    }

    // Periodically backfill momentum comparison fields on closed trades
    this.backfillTimer = setInterval(() => {
      this.tradeLogger.backfillMomentum();
    }, BACKFILL_INTERVAL_MS);
    this.tradeLogger.backfillMomentum();

    const enabledCount = Array.from(this.strategies.values()).filter(s => s.enabled).length;
    logger.info({ total: this.strategies.size, enabled: enabledCount }, 'StrategyManager initialized');
  }

  attachToPriceCollector(priceCollector: PriceCollector): void {
    if (!this.globalConfig.enabled) return;

    priceCollector.setT30Callback(
      (graduationId: number, ctx: ObservationContext, priceT30: number, pctT30: number, solReserves: number) => {
        this.fanOutT30(graduationId, ctx, priceT30, pctT30, solReserves);
      }
    );

    logger.info('Attached to PriceCollector T+30 callback (fan-out to %d strategies)', this.strategies.size);
  }

  /** Fan out T+30 signal to all enabled strategies */
  private fanOutT30(
    graduationId: number,
    ctx: ObservationContext,
    priceT30: number,
    pctT30: number,
    solReserves: number,
  ): void {
    const promises: Promise<void>[] = [];

    for (const instance of this.strategies.values()) {
      if (!instance.enabled) continue;
      promises.push(
        instance.evaluator.onT30(graduationId, ctx, priceT30, pctT30, solReserves).catch(err => {
          logger.error(
            'Strategy %s onT30 error for grad %d: %s',
            instance.id,
            graduationId,
            err instanceof Error ? err.message : String(err)
          );
        })
      );
    }

    // Fire and forget — don't block the price collector
    Promise.allSettled(promises);
  }

  // ── Strategy CRUD ──────────────────────────────────────────────────────────

  getStrategies(): StrategyInfo[] {
    return Array.from(this.strategies.values()).map(s => ({
      id: s.id,
      label: s.label,
      enabled: s.enabled,
      params: strategyParamsFromConfig(s.config),
      activePositions: s.positionManager.activeCount(),
    }));
  }

  getStrategy(id: string): StrategyInfo | undefined {
    const s = this.strategies.get(id);
    if (!s) return undefined;
    return {
      id: s.id,
      label: s.label,
      enabled: s.enabled,
      params: strategyParamsFromConfig(s.config),
      activePositions: s.positionManager.activeCount(),
    };
  }

  upsertStrategy(id: string, label: string, params: StrategyParams, enabled: boolean = true): void {
    // Validate ID format
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      throw new Error('Strategy ID must be lowercase alphanumeric + hyphens, 1-32 chars');
    }

    // Persist to DB
    upsertStrategyConfig(this.db, id, label, JSON.stringify(params), enabled ? 1 : 0);

    const existing = this.strategies.get(id);
    if (existing) {
      // Hot-swap config
      const newConfig = mergeStrategyParams(this.globalConfig, params);
      existing.config = newConfig;
      existing.label = label;
      existing.enabled = enabled;
      existing.evaluator.updateConfig(newConfig);

      if (enabled && !existing.positionManager.activeCount()) {
        // Ensure position manager is running if re-enabled
        existing.positionManager.start(this.connection);
      }

      logger.info({ strategyId: id }, 'Strategy updated: %s', describeTradingConfig(newConfig));
    } else {
      // Create new instance
      this.createInstance(id, label, enabled, params);
      const instance = this.strategies.get(id)!;
      if (enabled) {
        instance.positionManager.start(this.connection);
      }
      logger.info({ strategyId: id }, 'Strategy created: %s', describeTradingConfig(instance.config));
    }
  }

  deleteStrategy(id: string): { error?: string } {
    if (id === 'default') {
      return { error: 'Cannot delete the default strategy' };
    }

    const instance = this.strategies.get(id);
    if (instance && instance.positionManager.activeCount() > 0) {
      return { error: `Strategy "${id}" has ${instance.positionManager.activeCount()} open positions — close them first` };
    }

    if (instance) {
      instance.positionManager.stop();
      this.strategies.delete(id);
    }

    dbDeleteStrategy(this.db, id);
    logger.info({ strategyId: id }, 'Strategy deleted');
    return {};
  }

  toggleStrategy(id: string, enabled: boolean): void {
    const instance = this.strategies.get(id);
    if (!instance) throw new Error(`Strategy "${id}" not found`);

    instance.enabled = enabled;
    upsertStrategyConfig(
      this.db, id, instance.label,
      JSON.stringify(strategyParamsFromConfig(instance.config)),
      enabled ? 1 : 0,
    );

    if (enabled) {
      instance.positionManager.start(this.connection);
    }

    logger.info({ strategyId: id, enabled }, 'Strategy toggled');
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getConfig(): TradingConfig {
    return this.globalConfig;
  }

  getStats() {
    const allPositions: any[] = [];
    for (const s of this.strategies.values()) {
      for (const p of s.positionManager.getPositions()) {
        allPositions.push({
          tradeId: p.tradeId,
          mint: p.mint,
          strategyId: s.id,
          entryPriceSol: p.entryPriceSol,
          tpPriceSol: p.tpPriceSol,
          slPriceSol: p.slPriceSol,
          secondsHeld: Math.floor(Date.now() / 1000) - p.entryTimestamp,
          maxHoldSeconds: p.maxExitTimestamp - p.entryTimestamp,
        });
      }
    }

    return {
      enabled: this.globalConfig.enabled,
      mode: this.globalConfig.mode,
      strategyCount: this.strategies.size,
      enabledCount: Array.from(this.strategies.values()).filter(s => s.enabled).length,
      activePositions: allPositions.length,
      activePositionDetails: allPositions,
    };
  }

  getPerStrategyStats() {
    return getTradeStatsByStrategy(this.db);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  updateConnection(connection: Connection): void {
    this.connection = connection;
    for (const instance of this.strategies.values()) {
      instance.positionManager.updateConnection(connection);
    }
  }

  stop(): void {
    for (const instance of this.strategies.values()) {
      instance.positionManager.stop();
    }
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer);
      this.backfillTimer = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private createInstance(id: string, label: string, enabled: boolean, params: StrategyParams): void {
    const config = mergeStrategyParams(this.globalConfig, params);
    const positionManager = new PositionManager();
    const evaluator = new TradeEvaluator(
      this.db,
      config,
      this.tradeLogger,
      this.executor,
      positionManager,
      id,
    );

    // Wire position exits → close trade in DB
    positionManager.on('exit', (event: ExitEvent) => {
      this.handleExit(event, config).catch(err => {
        logger.error(
          'Exit handler error for trade %d (strategy %s): %s',
          event.position.tradeId,
          id,
          err instanceof Error ? err.message : String(err)
        );
      });
    });

    this.strategies.set(id, { id, label, enabled, config, evaluator, positionManager });
  }

  private async handleExit(event: ExitEvent, config: TradingConfig): Promise<void> {
    const { position: pos, exitReason, exitPriceSol } = event;

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
      tradeSizeSol: config.tradeSizeSol,
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      slGapPenaltyPct: config.slGapPenaltyPct,
      tpGapPenaltyPct: config.tpGapPenaltyPct,
      exitTxSignature: sellResult.txSignature,
    });
  }

  private recoverOpenPositions(): void {
    const openTrades = getOpenTrades(this.db) as any[];
    if (openTrades.length === 0) return;

    logger.info({ count: openTrades.length }, 'Recovering open positions from DB');

    for (const trade of openTrades) {
      const strategyId = trade.strategy_id || 'default';
      const instance = this.strategies.get(strategyId);

      if (!instance) {
        // Strategy was deleted — close the trade
        this.tradeLogger.closeTrade({
          tradeId: trade.id,
          entryPriceSol: trade.entry_price_sol,
          exitPriceSol: trade.entry_price_sol,
          exitReason: 'timeout',
          tradeSizeSol: trade.trade_size_sol,
          takeProfitPct: trade.take_profit_pct,
          stopLossPct: trade.stop_loss_pct,
          slGapPenaltyPct: this.globalConfig.slGapPenaltyPct,
          tpGapPenaltyPct: this.globalConfig.tpGapPenaltyPct,
        });
        logger.info({ tradeId: trade.id, strategyId }, 'Orphaned trade closed as timeout (strategy deleted)');
        continue;
      }

      if (trade.mode === 'paper') {
        this.tradeLogger.closeTrade({
          tradeId: trade.id,
          entryPriceSol: trade.entry_price_sol,
          exitPriceSol: trade.entry_price_sol,
          exitReason: 'timeout',
          tradeSizeSol: trade.trade_size_sol,
          takeProfitPct: trade.take_profit_pct,
          stopLossPct: trade.stop_loss_pct,
          slGapPenaltyPct: instance.config.slGapPenaltyPct,
          tpGapPenaltyPct: instance.config.tpGapPenaltyPct,
        });
        logger.info({ tradeId: trade.id, strategyId }, 'Paper position recovered → closed as timeout');
        continue;
      }

      // Live mode: re-register if vaults available
      if (!trade.base_vault || !trade.quote_vault) {
        this.tradeLogger.failTrade(trade.id, 'recovery_no_vaults');
        continue;
      }

      const entryPrice = trade.entry_effective_price ?? trade.entry_price_sol;
      instance.positionManager.addPosition({
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
      logger.info({ tradeId: trade.id, strategyId }, 'Live position recovered for monitoring');
    }
  }
}
