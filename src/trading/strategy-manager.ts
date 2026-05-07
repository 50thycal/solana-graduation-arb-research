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
import { PositionManager, ExitEvent, DynamicMonitorParams } from './position-manager';
import { TradeEvaluator } from './trade-evaluator';
import { PriceCollector, ObservationContext } from '../collector/price-collector';
import { Wallet } from './wallet';
import { isKillswitchTripped, maybeLogKillswitchTripped } from './safety';
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
  private wallet: Wallet | null;
  private backfillTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  // Watchdog telemetry: when the last T+30 callback fired across all strategies.
  // Used by /api/diagnose and snapshot.json to surface a stalled-pipeline state
  // (graduations arriving but callbacks not firing → PriceCollector wiring bug,
  // or no graduations at all → WS subscription dead).
  private lastT30CallbackAt: number | null = null;

  constructor(
    private db: Database.Database,
    private connection: Connection,
  ) {
    this.globalConfig = loadTradingConfig();
    this.tradeLogger = new TradeLogger(db);
    this.wallet = Wallet.fromEnv();
    // Executor gets connection + wallet so it can build live txs. Paper-only
    // deployments (no WALLET_PRIVATE_KEY set) still work — shadow/live modes
    // will return success:false with a clear error message.
    this.executor = new Executor(this.globalConfig.executionMode, this.connection, this.wallet);
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

    // Safety watchdog: every 10s check the killswitch and force-close open
    // live positions if tripped mid-session. Paper / shadow positions aren't
    // force-closed (they're harmless — no real exposure).
    this.safetyTimer = setInterval(() => this.safetyTick(), 10_000);

    const enabledCount = Array.from(this.strategies.values()).filter(s => s.enabled).length;
    logger.info({ total: this.strategies.size, enabled: enabledCount }, 'StrategyManager initialized');
  }

  private safetyTick(): void {
    if (!isKillswitchTripped()) return;
    maybeLogKillswitchTripped();
    // Force-close any open live positions. We route them through handleExit so
    // the normal sell path fires and net_profit_sol is computed consistently.
    for (const instance of this.strategies.values()) {
      for (const pos of instance.positionManager.getPositions()) {
        if (pos.mode !== 'live') continue;
        // Fire the exit event with the last known price — the sell path will
        // re-quote live price before submitting, so this is a safe approximation.
        const killEvent: ExitEvent = {
          position: pos,
          exitReason: 'killswitch',
          exitPriceSol: pos.highWaterMark || pos.entryPriceSol,
        };
        this.handleExit(killEvent, instance.config).catch(err => {
          logger.error(
            'Killswitch force-close failed for trade %d: %s',
            pos.tradeId, err instanceof Error ? err.message : String(err),
          );
        });
        instance.positionManager.removePosition(pos.tradeId);
      }
    }
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

  /** Fan out T+30 signal to all enabled strategies.
   *  Strategies whose filters reference buy_pressure_* fields are automatically
   *  delayed 5 seconds (to T+35) so those fields are populated before evaluation. */
  private fanOutT30(
    graduationId: number,
    ctx: ObservationContext,
    priceT30: number,
    pctT30: number,
    solReserves: number,
  ): void {
    this.lastT30CallbackAt = Date.now();
    const promises: Promise<void>[] = [];

    for (const instance of this.strategies.values()) {
      if (!instance.enabled) continue;

      // Filters that source from competition_signals (buy_pressure_* and sniper_*)
      // are written at T+35 by the same detectBuyPressure pass — strategies
      // referencing either family must delay evaluation 5s past T+30.
      const needsT35 = instance.config.filters.some(
        f => f.field.startsWith('buy_pressure_')
          || f.field.startsWith('sniper_'),
      );

      const entryTimingSec = instance.config.entryTimingSec ?? 30;
      // Required wall-clock delay past T+30 before evaluating.
      const delaySec = Math.max(entryTimingSec - 30, needsT35 ? 5 : 0);

      if (delaySec === 0) {
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
        continue;
      }

      // Delayed-entry path. For T+35 buy_pressure filters the entry price
      // stays at T+30 (matches sim). For entryTimingSec > 30 we re-read the
      // late-entry checkpoint from graduation_momentum at fire time.
      const lateEntry = entryTimingSec > 30;
      const delayed = new Promise<void>((resolve) => {
        setTimeout(() => {
          let evalPrice = priceT30;
          let evalPct = pctT30;
          if (lateEntry) {
            const priceCol = `price_t${entryTimingSec}`;
            const pctCol = `pct_t${entryTimingSec}`;
            const row = this.db.prepare(
              `SELECT ${priceCol} AS price, ${pctCol} AS pct
               FROM graduation_momentum WHERE graduation_id = ?`
            ).get(graduationId) as { price: number | null; pct: number | null } | undefined;
            if (!row || row.price == null || row.pct == null) {
              logger.debug(
                { strategyId: instance.id, graduationId, entryTimingSec },
                'Late-entry skipped — late checkpoint not yet populated'
              );
              resolve();
              return;
            }
            evalPrice = row.price;
            evalPct = row.pct;
          }
          instance.evaluator.onT30(graduationId, ctx, evalPrice, evalPct, solReserves)
            .catch(err => {
              logger.error(
                'Strategy %s delayed onT30 error for grad %d: %s',
                instance.id,
                graduationId,
                err instanceof Error ? err.message : String(err)
              );
            })
            .finally(resolve);
        }, delaySec * 1000);
      });
      promises.push(delayed);
      logger.debug(
        { strategyId: instance.id, graduationId, delaySec, entryTimingSec, needsT35 },
        'Delaying evaluation'
      );
    }

    // Fire and forget — don't block the price collector
    Promise.allSettled(promises);
  }

  // ── Watchdog telemetry ─────────────────────────────────────────────────────
  /**
   * Wall-clock ms of the last T+30 callback dispatched (across any strategy).
   * Null until the PriceCollector first fires. Used by /api/diagnose +
   * snapshot.json to detect stalled pipelines.
   */
  getLastT30CallbackAt(): number | null {
    return this.lastT30CallbackAt;
  }

  /** True if at least one strategy is currently enabled. */
  hasEnabledStrategies(): boolean {
    for (const s of this.strategies.values()) {
      if (s.enabled) return true;
    }
    return false;
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

    // Fix Issue 6: validate numeric params at the API boundary
    this.validateStrategyParams(params);

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
      existing.positionManager.updateDynamicParams(StrategyManager.extractDynamicParams(newConfig));

      // positionMonitorMode is baked into the PositionManager at construction
      // time and cannot be hot-swapped. Warn if the user changed it — the new
      // mode takes effect after the next bot restart.
      const oldMode = strategyParamsFromConfig(existing.config).positionMonitorMode ?? 'five_second';
      const newMode = params.positionMonitorMode ?? 'five_second';
      if (oldMode !== newMode) {
        logger.warn(
          { strategyId: id, oldMode, newMode },
          'positionMonitorMode changed — restart the bot for this to take effect'
        );
      }

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

  /**
   * Reconcile the in-memory strategy cache against the strategy_configs DB
   * table. Catches drift where a delete/upsert/toggle bypassed the in-memory
   * path (e.g. external SQL, multi-process race, or a bug in the command
   * pipeline that updated DB but not memory). Safe to call repeatedly — only
   * acts when state actually differs.
   *
   * Drift signals to look for in the returned counts:
   *   - removed > 0  → DB no longer has a strategy that's in memory (potential
   *     cause of the "deleted strategy still trading" symptom seen 2026-05-07)
   *   - added > 0    → DB has a strategy that memory doesn't (e.g. upsert
   *     persisted but createInstance failed earlier)
   *   - toggled > 0  → enabled flag diverged
   */
  reconcileFromDb(): { removed: number; added: number; toggled: number } {
    const dbRows = getStrategyConfigs(this.db);
    const dbIds = new Set(dbRows.map(r => r.id));
    let removed = 0;
    let added = 0;
    let toggled = 0;

    // Memory has a strategy that DB doesn't → stop & remove.
    // Default is exempt — it lives in memory even if the row gets cleared.
    for (const [id, instance] of this.strategies) {
      if (id === 'default') continue;
      if (!dbIds.has(id)) {
        logger.warn(
          { strategyId: id, activePositions: instance.positionManager.activeCount() },
          'Reconcile: strategy in memory but missing from DB — stopping & removing',
        );
        instance.positionManager.stop();
        this.strategies.delete(id);
        removed++;
      }
    }

    // DB has a strategy that memory doesn't, or enabled flag drifted → fix.
    for (const row of dbRows) {
      const dbEnabled = row.enabled === 1;
      const existing = this.strategies.get(row.id);
      if (!existing) {
        try {
          const params = JSON.parse(row.config_json) as StrategyParams;
          this.createInstance(row.id, row.label, dbEnabled, params);
          if (dbEnabled) {
            this.strategies.get(row.id)!.positionManager.start(this.connection);
          }
          logger.warn({ strategyId: row.id }, 'Reconcile: strategy in DB but missing from memory — created');
          added++;
        } catch (err) {
          logger.error(
            { strategyId: row.id, err: err instanceof Error ? err.message : String(err) },
            'Reconcile: failed to materialize DB strategy in memory',
          );
        }
      } else if (existing.enabled !== dbEnabled) {
        existing.enabled = dbEnabled;
        if (dbEnabled) {
          existing.positionManager.start(this.connection);
        } else {
          existing.positionManager.stop();
        }
        logger.warn(
          { strategyId: row.id, dbEnabled, prevEnabled: !dbEnabled },
          'Reconcile: enabled flag drifted — synced from DB',
        );
        toggled++;
      }
    }

    return { removed, added, toggled };
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
          effectiveSlPriceSol: p.effectiveSlPriceSol,
          highWaterMark: p.highWaterMark,
          trailingSlActive: p.trailingSlActive,
          tpThresholdHit: p.tpThresholdHit,
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
      instance.evaluator.updateConnection(connection);
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
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Fix Issue 6: reject obviously invalid or dangerous param values before DB write. */
  private validateStrategyParams(p: StrategyParams): void {
    const errors: string[] = [];
    if (!isFinite(p.tradeSizeSol) || p.tradeSizeSol <= 0 || p.tradeSizeSol > 100) {
      errors.push('tradeSizeSol must be between 0 and 100');
    }
    if (!Number.isInteger(p.maxConcurrentPositions) || p.maxConcurrentPositions < 1 || p.maxConcurrentPositions > 50) {
      errors.push('maxConcurrentPositions must be an integer 1–50');
    }
    if (!isFinite(p.entryGateMinPctT30) || p.entryGateMinPctT30 < -100 || p.entryGateMinPctT30 > 1000) {
      errors.push('entryGateMinPctT30 must be between -100 and 1000');
    }
    if (!isFinite(p.entryGateMaxPctT30) || p.entryGateMaxPctT30 <= p.entryGateMinPctT30) {
      errors.push('entryGateMaxPctT30 must be greater than entryGateMinPctT30');
    }
    if (!isFinite(p.takeProfitPct) || p.takeProfitPct <= 0 || p.takeProfitPct > 10000) {
      errors.push('takeProfitPct must be between 0 and 10000');
    }
    if (!isFinite(p.stopLossPct) || p.stopLossPct <= 0 || p.stopLossPct >= 100) {
      errors.push('stopLossPct must be between 0 and 100');
    }
    if (!Number.isInteger(p.maxHoldSeconds) || p.maxHoldSeconds < 10 || p.maxHoldSeconds > 86400) {
      errors.push('maxHoldSeconds must be an integer between 10 and 86400');
    }
    if (!isFinite(p.slGapPenaltyPct) || p.slGapPenaltyPct < 0 || p.slGapPenaltyPct > 100) {
      errors.push('slGapPenaltyPct must be between 0 and 100');
    }
    if (!isFinite(p.tpGapPenaltyPct) || p.tpGapPenaltyPct < 0 || p.tpGapPenaltyPct > 100) {
      errors.push('tpGapPenaltyPct must be between 0 and 100');
    }
    if (!Array.isArray(p.filters)) {
      errors.push('filters must be an array');
    }
    // ── Dynamic position monitoring validation ──────────────────────────
    const tsa = p.trailingSlActivationPct ?? 0;
    const tsd = p.trailingSlDistancePct ?? 5;
    if (!isFinite(tsa) || tsa < 0 || tsa > 1000) {
      errors.push('trailingSlActivationPct must be between 0 and 1000');
    }
    if (!isFinite(tsd) || tsd <= 0 || tsd >= 100) {
      errors.push('trailingSlDistancePct must be between 0 and 100 (exclusive)');
    }
    if (tsa > 0 && tsd >= tsa) {
      errors.push('trailingSlDistancePct must be less than trailingSlActivationPct');
    }
    const sld = p.slActivationDelaySec ?? 0;
    if (!Number.isInteger(sld) || sld < 0 || sld > p.maxHoldSeconds) {
      errors.push('slActivationDelaySec must be an integer between 0 and maxHoldSeconds');
    }
    const ttpd = p.trailingTpDropPct ?? 5;
    if (!isFinite(ttpd) || ttpd <= 0 || ttpd > 100) {
      errors.push('trailingTpDropPct must be between 0 and 100');
    }
    const t1 = p.tightenSlAtPctTime ?? 0;
    const t2 = p.tightenSlAtPctTime2 ?? 0;
    if (!isFinite(t1) || t1 < 0 || t1 > 100) {
      errors.push('tightenSlAtPctTime must be between 0 and 100');
    }
    if (!isFinite(t2) || t2 < 0 || t2 > 100) {
      errors.push('tightenSlAtPctTime2 must be between 0 and 100');
    }
    if (t1 > 0 && t2 > 0 && t2 <= t1) {
      errors.push('tightenSlAtPctTime2 must be greater than tightenSlAtPctTime');
    }
    const ts1 = p.tightenSlTargetPct ?? 7;
    const ts2 = p.tightenSlTargetPct2 ?? 5;
    if (!isFinite(ts1) || ts1 <= 0 || ts1 >= 100) {
      errors.push('tightenSlTargetPct must be between 0 and 100');
    }
    if (!isFinite(ts2) || ts2 <= 0 || ts2 >= 100) {
      errors.push('tightenSlTargetPct2 must be between 0 and 100');
    }
    if (t1 > 0 && t2 > 0 && ts2 >= ts1) {
      errors.push('tightenSlTargetPct2 should be tighter (smaller) than tightenSlTargetPct');
    }
    const bp = p.breakevenStopPct ?? 0;
    if (!isFinite(bp) || bp < 0 || bp > 1000) {
      errors.push('breakevenStopPct must be between 0 and 1000');
    }
    // ── Live-execution params ────────────────────────────────────────────
    if (p.executionMode != null) {
      const valid = ['paper', 'shadow', 'live_micro', 'live_full'];
      if (!valid.includes(p.executionMode)) {
        errors.push(`executionMode must be one of ${valid.join(', ')}`);
      }
    }
    if (p.jitoTipSol != null) {
      if (!isFinite(p.jitoTipSol) || p.jitoTipSol < 0 || p.jitoTipSol > 0.1) {
        errors.push('jitoTipSol must be between 0 and 0.1');
      }
    }
    if (p.maxSlippageBps != null) {
      if (!Number.isInteger(p.maxSlippageBps) || p.maxSlippageBps < 1 || p.maxSlippageBps > 10_000) {
        errors.push('maxSlippageBps must be an integer between 1 and 10000');
      }
    }
    if (p.entryTimingSec != null) {
      const allowed = [30, 60, 90, 120, 180, 240, 300];
      if (!allowed.includes(p.entryTimingSec)) {
        errors.push(`entryTimingSec must be one of ${allowed.join(', ')}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Invalid strategy params: ${errors.join('; ')}`);
    }
  }

  private static extractDynamicParams(cfg: TradingConfig): DynamicMonitorParams {
    return {
      stopLossPct: cfg.stopLossPct,
      maxHoldSeconds: cfg.maxHoldSeconds,
      trailingSlActivationPct: cfg.trailingSlActivationPct ?? 0,
      trailingSlDistancePct: cfg.trailingSlDistancePct ?? 5,
      slActivationDelaySec: cfg.slActivationDelaySec ?? 0,
      trailingTpEnabled: cfg.trailingTpEnabled ?? false,
      trailingTpDropPct: cfg.trailingTpDropPct ?? 5,
      tightenSlAtPctTime: cfg.tightenSlAtPctTime ?? 0,
      tightenSlTargetPct: cfg.tightenSlTargetPct ?? 7,
      tightenSlAtPctTime2: cfg.tightenSlAtPctTime2 ?? 0,
      tightenSlTargetPct2: cfg.tightenSlTargetPct2 ?? 5,
      breakevenStopPct: cfg.breakevenStopPct ?? 0,
    };
  }

  private createInstance(id: string, label: string, enabled: boolean, params: StrategyParams): void {
    const config = mergeStrategyParams(this.globalConfig, params);
    const monitorMode = params.positionMonitorMode ?? 'five_second';
    const dynamicParams = StrategyManager.extractDynamicParams(config);
    const positionManager = new PositionManager(monitorMode, dynamicParams);
    const evaluator = new TradeEvaluator(
      this.db,
      config,
      this.tradeLogger,
      this.executor,
      positionManager,
      id,
      this.connection,
      this.wallet,
    );

    // Wire position exits → close trade in DB
    // Fix Issue 2: read config from the live instance at exit time (not the captured
    // creation-time local) so hot-swapped TP/SL/gap values are always used.
    positionManager.on('exit', (event: ExitEvent) => {
      const liveConfig = this.strategies.get(id)?.config ?? config;
      this.handleExit(event, liveConfig).catch(err => {
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

    const executionMode = pos.executionMode ?? config.executionMode ?? 'paper';
    const poolCtx = (pos.baseVault && pos.quoteVault)
      ? { poolAddress: pos.poolAddress, baseVault: pos.baseVault, quoteVault: pos.quoteVault }
      : undefined;

    let sellResult;
    try {
      sellResult = await this.executor.sell(
        pos.mint, pos.tokensHeld, exitPriceSol, pos.slippageEstPct, poolCtx, executionMode,
      );
    } catch (err) {
      logger.error({ tradeId: pos.tradeId }, 'Sell execution threw: %s', err instanceof Error ? err.message : String(err));
      sellResult = {
        success: true, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: executionMode === 'paper' || executionMode === 'shadow',
      } as Awaited<ReturnType<typeof this.executor.sell>>;
    }

    // closeTrade applies either measured slippage (live modes) or gap
    // penalty (paper/shadow) on top of this raw spot price — do NOT
    // pre-discount here or the live path double-counts.
    this.tradeLogger.closeTrade({
      tradeId: pos.tradeId,
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol,
      exitReason,
      tradeSizeSol: config.tradeSizeSol,
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      slGapPenaltyPct: config.slGapPenaltyPct,
      tpGapPenaltyPct: config.tpGapPenaltyPct,
      exitTxSignature: sellResult.txSignature,
      measuredExitSlippagePct: sellResult.measuredSlippagePct,
      shadowMeasuredExitSlippagePct: executionMode === 'shadow' ? sellResult.measuredSlippagePct : undefined,
      jitoTipSol: sellResult.jitoTipSol,
      txLandMs: sellResult.txLandMs,
      executionMode,
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
      const slPriceSol = entryPrice * (1 - trade.stop_loss_pct / 100);
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
        slPriceSol,
        maxExitTimestamp: trade.entry_timestamp + trade.max_hold_seconds,
        tokensHeld: trade.entry_tokens_received ?? 0,
        mode: 'live',
        executionMode: (trade.execution_mode as any) ?? 'live_full',
        // graduation_timestamp not stored on trades_v2; approximate from entry
        graduationDetectedAt: trade.entry_timestamp - 30,
        // Dynamic monitoring runtime state — initialize conservatively on recovery
        highWaterMark: entryPrice,
        trailingSlActive: false,
        tpThresholdHit: false,
        postTpHighWaterMark: 0,
        effectiveSlPriceSol: slPriceSol,
      });
      logger.info({ tradeId: trade.id, strategyId }, 'Live position recovered for monitoring');
    }
  }
}
