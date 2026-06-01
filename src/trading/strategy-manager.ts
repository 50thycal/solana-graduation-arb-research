import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  loadTradingConfig,
  describeTradingConfig,
  TradingConfig,
  StrategyParams,
  strategyParamsFromConfig,
  mergeStrategyParams,
  SWAP_SLIPPAGE_BPS,
} from './config';
import { TradeLogger } from './trade-logger';
import { Executor, fetchVaultPrice } from './executor';
import { PositionManager, ExitEvent, DynamicMonitorParams, ActivePosition } from './position-manager';
import { TradeEvaluator } from './trade-evaluator';
import { MarkovMatrixStore, REFIT_PATHS_THRESHOLD } from './markov-matrix';
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

/** Live-sell retry schedule (2026-05-27 redesign).
 *
 *  Pre-fix: retried up to 20 times with [2s/5s/10s/30s/60s × N] backoff and
 *  flat 10% slippage on every attempt. Took up to 17 min to terminal-close
 *  stuck positions, and most retries fought the same Custom 6004 because
 *  the AMM math hadn't changed.
 *
 *  New approach — 9 attempts total, no explicit backoff (poll cadence is
 *  the floor). Each attempt escalates slippage AND/OR Jito tip to break
 *  out of the failure mode:
 *
 *    Attempt 1: 10% slippage, 1× tip — normal exit (most trades succeed here)
 *    Attempt 2: 20% slippage, 5× tip — bump tip aggressively for faster land
 *    Attempt 3: 20% slippage, 5× tip — one more shot with high tip
 *    Attempt 4: 40% slippage, 1× tip — high tip didn't help, crank slippage
 *    Attempt 5: 50% slippage, 1× tip — slippage ramp
 *    Attempt 6: 60% slippage, 1× tip
 *    Attempt 7: 70% slippage, 1× tip
 *    Attempt 8: 80% slippage, 1× tip
 *    Attempt 9: 90% slippage, 1× tip — last attempt (terminal close after)
 *
 *  After attempt 9 fails, the position is closed with sell_failed_terminal
 *  and net_profit_sol reflects the realized loss. */
const MAX_SELL_ATTEMPTS_BEFORE_TERMINAL = 9;

/** Per-attempt slippage tolerance in basis points. Index 0 = attempt 1.
 *  Attempt 1 uses the default SWAP_SLIPPAGE_BPS (env-configurable, typically
 *  1000 = 10%); attempts 2+ use absolute values from this table. */
const SELL_RETRY_SLIPPAGE_BPS: ReadonlyArray<number | null> = [
  null,   // 1: SWAP_SLIPPAGE_BPS default
  2000,   // 2: 20%
  2000,   // 3: 20%
  4000,   // 4: 40%
  5000,   // 5: 50%
  6000,   // 6: 60%
  7000,   // 7: 70%
  8000,   // 8: 80%
  9000,   // 9: 90%
];
function sellSlippageBpsForAttempt(attemptNumber: number): number {
  if (attemptNumber < 1) return SWAP_SLIPPAGE_BPS;
  const idx = Math.min(attemptNumber - 1, SELL_RETRY_SLIPPAGE_BPS.length - 1);
  return SELL_RETRY_SLIPPAGE_BPS[idx] ?? SWAP_SLIPPAGE_BPS;
}

/** Per-attempt Jito tip multiplier vs DEFAULT_JITO_TIP_SOL. Attempts 2-3
 *  use 5× to push the bundle up Jito's priority queue and reduce tx_land_ms.
 *  If that doesn't land the sell, attempt 4+ drops back to 1× since paying
 *  more tip on a tx that's failing for slippage/AMM-state reasons just burns
 *  SOL — switch to widening slippage instead. */
const SELL_RETRY_TIP_MULTIPLIER: ReadonlyArray<number> = [
  1,  // 1: default
  5,  // 2: aggressive land
  5,  // 3: aggressive land
  1,  // 4: back to normal, slippage takes over
  1,  // 5
  1,  // 6
  1,  // 7
  1,  // 8
  1,  // 9
];
function sellTipMultiplierForAttempt(attemptNumber: number): number {
  if (attemptNumber < 1) return 1;
  const idx = Math.min(attemptNumber - 1, SELL_RETRY_TIP_MULTIPLIER.length - 1);
  return SELL_RETRY_TIP_MULTIPLIER[idx];
}

/** Error patterns that indicate a sell will never succeed — close terminally
 *  immediately instead of waiting for MAX_SELL_RETRIES_BEFORE_TERMINAL. Pattern
 *  match is case-insensitive substring. */
const TERMINAL_SELL_ERROR_PATTERNS = [
  'no tokens in wallet',           // wallet is confirmed empty for this mint
  'pool reserves read failed',     // pool is dead / migrated / removed
  'pool context incomplete',       // pool was never resolvable
];

interface StrategyInstance {
  id: string;
  label: string;
  enabled: boolean;
  config: TradingConfig;
  evaluator: TradeEvaluator;
  positionManager: PositionManager;
  markovFilterKey: string;
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
  private markovStore: MarkovMatrixStore;
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
    this.markovStore = new MarkovMatrixStore();
  }

  getMarkovStore(): MarkovMatrixStore {
    return this.markovStore;
  }

  /** Refit every registered filter's matrix and update the consumed-paths
   *  counter. Cheap — single SQL pass per filter, runs on a timer. */
  private refitMarkovMatrices(): void {
    const totalLabeledPaths = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM graduation_momentum WHERE pct_t300 IS NOT NULL`
    ).get() as { n: number }).n;
    if (!this.markovStore.isRefitDue(totalLabeledPaths)) return;
    if (this.markovStore.registeredKeys().length === 0) return;
    this.markovStore.refitAll(this.db, totalLabeledPaths);
    logger.info(
      {
        pathsConsumed: totalLabeledPaths,
        filterKeys: this.markovStore.registeredKeys(),
        refitThreshold: REFIT_PATHS_THRESHOLD,
      },
      'Markov matrices refit'
    );
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

    // Recover open positions from previous run. Async (per-position wallet
    // balance checks for live trades) — fire-and-forget so the constructor
    // returns immediately. Position managers (started below) only iterate
    // positions currently in their map, so a slight delay before recovered
    // positions register simply means they start being monitored a beat later.
    this.recoverOpenPositions().catch(err => {
      logger.error('recoverOpenPositions failed: %s', err instanceof Error ? err.message : String(err));
    });

    // Start all position managers
    for (const instance of this.strategies.values()) {
      if (instance.enabled) {
        instance.positionManager.start(this.connection);
      }
    }

    // Periodically backfill momentum comparison fields on closed trades.
    // Also fold in the Markov refit check on the same cadence — refit only
    // fires when REFIT_PATHS_THRESHOLD (50) new closed paths have landed.
    this.backfillTimer = setInterval(() => {
      this.tradeLogger.backfillMomentum();
      this.refitMarkovMatrices();
    }, BACKFILL_INTERVAL_MS);
    this.tradeLogger.backfillMomentum();
    // Initial fit so any markov-enabled strategies have data on bot start.
    this.markovStore.refitAll(
      this.db,
      (this.db.prepare(`SELECT COUNT(*) AS n FROM graduation_momentum WHERE pct_t300 IS NOT NULL`)
        .get() as { n: number }).n,
    );

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
        // Fire-and-forget: each position's force-close runs independently so
        // the safety loop doesn't block on RPC. removePosition is synchronous
        // — done after kicking off to prevent the next tick from re-iterating
        // the same position.
        this.forceCloseLivePosition(pos, instance).catch(err => {
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

      // Filters that source from competition_signals (buy_pressure_*, sniper_*,
      // flow_*, vwap_*, price_vs_vwap_*, firstbuyer_*) are written at T+35 by
      // the same detectBuyPressure pass. C5 recovery_* / confirmed_dip_* are
      // written at T+45 by price-collector. Strategies referencing any of those
      // families must delay evaluation 30s past T+30 — detectBuyPressure does
      // up to 50 RPC tx parses (5–20s of work) and a 5s delay frequently saw
      // NULL=FAIL on the new fields (root cause of v22 zero-trade bug
      // 2026-05-12). Keep this prefix list in sync with detectBuyPressure() in
      // src/collector/competition-detector.ts and updateMomentumRecoveryFlags
      // in src/collector/price-collector.ts.
      const LATE_PREFIXES = [
        'buy_pressure_',
        'sniper_',
        'flow_',
        'vwap_',
        'price_vs_vwap_',
        'firstbuyer_',
        'recovery_',
        'confirmed_dip_',
      ];
      const needsLate = instance.config.filters.some(
        f => LATE_PREFIXES.some(p => f.field.startsWith(p)),
      );

      const entryTimingSec = instance.config.entryTimingSec ?? 30;
      // Required wall-clock delay past T+30 before evaluating. 30s gives
      // detectBuyPressure and the T+45 recovery-flag write reliable time to
      // complete (was 5s and frequently raced — see comment above).
      const delaySec = Math.max(entryTimingSec - 30, needsLate ? 30 : 0);

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
        { strategyId: instance.id, graduationId, delaySec, entryTimingSec, needsLate },
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
    // Validate ID format. Allow lowercase + uppercase alphanumerics, hyphens,
    // and dots so cohort-numbered IDs like V29.1 round-trip cleanly. 1-32 chars.
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{0,31}$/.test(id)) {
      throw new Error('Strategy ID must be alphanumeric + hyphens + dots, 1-32 chars');
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

      // Re-register filter spec with the matrix store — if the filter set
      // changed, the next refit will build a fresh matrix for it.
      const newKey = this.markovStore.registerFilter(
        newConfig.filters,
        newConfig.entryGateMinPctT30,
        newConfig.entryGateMaxPctT30,
      );
      existing.markovFilterKey = newKey;
      existing.evaluator.setMarkovFilterKey(newKey);

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
    const ttpMinLift = p.trailingTpMinPeakLiftPct ?? 0;
    if (!isFinite(ttpMinLift) || ttpMinLift < 0 || ttpMinLift > 500) {
      errors.push('trailingTpMinPeakLiftPct must be between 0 and 500');
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
    // Markov exit thresholds — both probabilities, exit < hold
    const mexit = p.markovExitProbThreshold ?? 0.30;
    const mhold = p.markovHoldProbThreshold ?? 0.85;
    if (!isFinite(mexit) || mexit < 0 || mexit > 1) {
      errors.push('markovExitProbThreshold must be between 0 and 1');
    }
    if (!isFinite(mhold) || mhold < 0 || mhold > 1) {
      errors.push('markovHoldProbThreshold must be between 0 and 1');
    }
    if (mexit >= mhold) {
      errors.push('markovExitProbThreshold must be less than markovHoldProbThreshold');
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
    if (p.pollIntervalSec != null) {
      if (!Number.isInteger(p.pollIntervalSec) || p.pollIntervalSec < 1 || p.pollIntervalSec > 5) {
        errors.push('pollIntervalSec must be an integer in [1, 5]');
      }
    }
    // entry-hour-utc window: either both set or neither.
    const hourMinSet = p.entryHourUtcMin != null;
    const hourMaxSet = p.entryHourUtcMax != null;
    if (hourMinSet !== hourMaxSet) {
      errors.push('entryHourUtcMin and entryHourUtcMax must be set together (both or neither)');
    }
    if (hourMinSet && hourMaxSet) {
      if (!Number.isInteger(p.entryHourUtcMin) || p.entryHourUtcMin! < 0 || p.entryHourUtcMin! > 23) {
        errors.push('entryHourUtcMin must be an integer 0-23');
      }
      if (!Number.isInteger(p.entryHourUtcMax) || p.entryHourUtcMax! < 0 || p.entryHourUtcMax! > 23) {
        errors.push('entryHourUtcMax must be an integer 0-23');
      }
    }
    // Market-regime gate bounds. Each pair (min, max) is independent.
    const checkRange = (
      name: string, min: number | undefined, max: number | undefined,
      lo: number, hi: number,
    ): void => {
      if (min != null && (!isFinite(min) || min < lo || min > hi)) errors.push(`${name}Min must be in [${lo}, ${hi}]`);
      if (max != null && (!isFinite(max) || max < lo || max > hi)) errors.push(`${name}Max must be in [${lo}, ${hi}]`);
      if (min != null && max != null && min > max) errors.push(`${name}Min must be <= ${name}Max`);
    };
    checkRange('entrySolReturnPct', p.entrySolReturnPctMin, p.entrySolReturnPctMax, -100, 1000);
    checkRange('entryBtcReturnPct', p.entryBtcReturnPctMin, p.entryBtcReturnPctMax, -100, 1000);
    checkRange('entryFngValue', p.entryFngValueMin, p.entryFngValueMax, 0, 100);
    if (p.regimeGate != null && p.regimeGate !== 'skip_red' && p.regimeGate !== 'green_only') {
      errors.push(`regimeGate must be 'skip_red' or 'green_only' (got '${p.regimeGate}')`);
    }
    if (errors.length > 0) {
      throw new Error(`Invalid strategy params: ${errors.join('; ')}`);
    }
  }

  private static extractDynamicParams(cfg: TradingConfig): DynamicMonitorParams {
    return {
      stopLossPct: cfg.stopLossPct,
      maxHoldSeconds: cfg.maxHoldSeconds,
      pollIntervalSec: Math.max(1, Math.min(5, cfg.pollIntervalSec ?? 5)),
      trailingSlActivationPct: cfg.trailingSlActivationPct ?? 0,
      trailingSlDistancePct: cfg.trailingSlDistancePct ?? 5,
      slActivationDelaySec: cfg.slActivationDelaySec ?? 0,
      trailingTpEnabled: cfg.trailingTpEnabled ?? false,
      trailingTpDropPct: cfg.trailingTpDropPct ?? 5,
      trailingTpMinPeakLiftPct: cfg.trailingTpMinPeakLiftPct ?? 0,
      tightenSlAtPctTime: cfg.tightenSlAtPctTime ?? 0,
      tightenSlTargetPct: cfg.tightenSlTargetPct ?? 7,
      tightenSlAtPctTime2: cfg.tightenSlAtPctTime2 ?? 0,
      tightenSlTargetPct2: cfg.tightenSlTargetPct2 ?? 5,
      breakevenStopPct: cfg.breakevenStopPct ?? 0,
      markovExitEnabled: cfg.markovExitEnabled ?? false,
      markovExitProbThreshold: cfg.markovExitProbThreshold ?? 0.30,
      markovHoldProbThreshold: cfg.markovHoldProbThreshold ?? 0.85,
    };
  }

  private createInstance(id: string, label: string, enabled: boolean, params: StrategyParams): void {
    const config = mergeStrategyParams(this.globalConfig, params);
    const monitorMode = params.positionMonitorMode ?? 'five_second';
    const dynamicParams = StrategyManager.extractDynamicParams(config);
    const positionManager = new PositionManager(monitorMode, dynamicParams, this.markovStore);
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

    // Register this strategy's filter set with the matrix store so the next
    // refit pass builds a matrix for it. Cheap and idempotent.
    const markovFilterKey = this.markovStore.registerFilter(
      config.filters,
      config.entryGateMinPctT30,
      config.entryGateMaxPctT30,
    );
    evaluator.setMarkovFilterKey(markovFilterKey);

    // Wire position exits → close trade in DB
    // Fix Issue 2: read config from the live instance at exit time (not the captured
    // creation-time local) so hot-swapped TP/SL/gap values are always used.
    positionManager.on('exit', (event: ExitEvent) => {
      const liveConfig = this.strategies.get(id)?.config ?? config;
      this.handleExit(event, liveConfig, positionManager).catch(err => {
        logger.error(
          'Exit handler error for trade %d (strategy %s): %s',
          event.position.tradeId,
          id,
          err instanceof Error ? err.message : String(err)
        );
      });
    });

    this.strategies.set(id, { id, label, enabled, config, evaluator, positionManager, markovFilterKey });
  }

  /** Killswitch helper: fetch a fresh pool price (so the trade row records
   *  reality, not a cached HWM) and route through handleExit. Falls back to
   *  the cached high-water-mark or entry price if RPC is unreachable. */
  private async forceCloseLivePosition(pos: ActivePosition, instance: StrategyInstance): Promise<void> {
    let exitPriceSol = pos.highWaterMark || pos.entryPriceSol;
    if (this.connection && pos.baseVault && pos.quoteVault) {
      const pool = await fetchVaultPrice(
        this.connection, pos.baseVault, pos.quoteVault, true,
      ).catch(() => null);
      if (pool && pool.priceSol > 0) exitPriceSol = pool.priceSol;
    }
    const killEvent: ExitEvent = { position: pos, exitReason: 'killswitch', exitPriceSol };
    await this.handleExit(killEvent, instance.config, instance.positionManager);
  }

  private async handleExit(
    event: ExitEvent,
    config: TradingConfig,
    positionManager: PositionManager,
  ): Promise<void> {
    const { position: pos, exitReason, exitPriceSol } = event;

    const executionMode = pos.executionMode ?? config.executionMode ?? 'paper';
    const isLive = executionMode === 'live_micro' || executionMode === 'live_full';
    const poolCtx = (pos.baseVault && pos.quoteVault)
      ? { poolAddress: pos.poolAddress, baseVault: pos.baseVault, quoteVault: pos.quoteVault }
      : undefined;

    // Compute this attempt's slippage + tip from the retry schedule. Live only —
    // shadow/paper modes don't use these. attemptNumber = pos.sellRetryCount+1
    // (sellRetryCount is the # of prior failures; +1 = the attempt about to fire).
    const attemptNumber = (pos.sellRetryCount ?? 0) + 1;
    const slippageBpsForThisAttempt = isLive
      ? sellSlippageBpsForAttempt(attemptNumber)
      : undefined;
    const tipMultiplierForThisAttempt = isLive
      ? sellTipMultiplierForAttempt(attemptNumber)
      : undefined;

    let sellResult;
    try {
      sellResult = await this.executor.sell(
        pos.mint, pos.tokensHeld, exitPriceSol, pos.slippageEstPct, poolCtx, executionMode,
        {
          slippageBpsOverride: slippageBpsForThisAttempt,
          jitoTipMultiplier: tipMultiplierForThisAttempt,
          attemptNumber,
        },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { tradeId: pos.tradeId, mint: pos.mint, mode: executionMode },
        'Sell execution threw: %s', errMsg,
      );
      sellResult = {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: executionMode === 'paper' || executionMode === 'shadow',
        errorMessage: errMsg,
      } as Awaited<ReturnType<typeof this.executor.sell>>;
    }

    // Non-live (shadow/paper) sell that returned !success: there's no on-chain
    // state to reconcile, so we still close the trade — but record the failure
    // reason so promotion logic can spot degraded shadow rows. Pre-fix,
    // shadowSell fake-succeeded on pool read failure and these rows looked
    // indistinguishable from clean shadow exits.
    if (!sellResult.success && !isLive) {
      const reason = (sellResult as { errorMessage?: string }).errorMessage ?? 'unknown';
      logger.warn(
        { tradeId: pos.tradeId, mint: pos.mint, mode: executionMode, exitReason, reason },
        'Non-live sell modeled via gap-penalty — pool read or context unavailable',
      );
    }

    // Live mode + failed sell: tokens are still on-chain. We MUST NOT mark the
    // trade closed with phantom exit numbers — that hides the real state and
    // strands the user's tokens (the 2026-05-17 silent-close bug). Re-arm the
    // position with an incremented retry counter so the next monitor cycle
    // retries the exit. After MAX_SELL_RETRIES, give up and surface as a
    // failed trade so manual intervention is visible on the dashboard.
    if (!sellResult.success && isLive) {
      const errMsg = (sellResult as { errorMessage?: string }).errorMessage ?? 'unknown';
      // Killswitch is operator-triggered "stop everything"; retrying on its
      // behalf defeats the purpose AND races with safetyTick's synchronous
      // removePosition. Fail-fast so the trade row reflects the failed exit
      // and surfaces for manual intervention.
      if (exitReason === 'killswitch') {
        logger.error(
          { tradeId: pos.tradeId, mint: pos.mint, mode: executionMode, errorMessage: errMsg },
          'Killswitch sell failed — not retrying, marking needs_manual_close',
        );
        const killswitchSr = sellResult as {
          txSignature?: string;
          txLandMs?: number;
          jitoTipSol?: number;
          failurePath?: string;
          mintExtensionFlags?: string | null;
          failureContext?: Record<string, unknown>;
        };
        this.tradeLogger.failTrade(
          pos.tradeId,
          `killswitch_sell_failed: ${errMsg}`,
          {
            txSignature: killswitchSr.txSignature,
            txLandMs: killswitchSr.txLandMs,
            jitoTipSol: killswitchSr.jitoTipSol,
            failurePath: killswitchSr.failurePath,
            mintExtensionFlags: killswitchSr.mintExtensionFlags,
            failureContext: killswitchSr.failureContext,
          },
        );
        return;
      }
      // Decide whether this attempt's failure is terminal. Two paths:
      //   1. Error message matches a known-terminal pattern → close on first hit.
      //   2. This was attempt #MAX_SELL_ATTEMPTS_BEFORE_TERMINAL — schedule is
      //      exhausted, close as realized loss.
      // Both paths route through closeTrade so net_profit_sol reflects the
      // loss. attemptNumber was computed above before the sell call.
      const lowerErr = errMsg.toLowerCase();
      const matchedPattern = TERMINAL_SELL_ERROR_PATTERNS.find(p => lowerErr.includes(p));
      const scheduleExhausted = attemptNumber >= MAX_SELL_ATTEMPTS_BEFORE_TERMINAL;
      const isTerminalSellFailure = !!matchedPattern || scheduleExhausted;
      if (isTerminalSellFailure) {
        logger.error(
          {
            tradeId: pos.tradeId, mint: pos.mint, mode: executionMode,
            exitReason, exitPriceSol, errorMessage: errMsg,
            attemptNumber,
            slippageBpsUsed: slippageBpsForThisAttempt,
            tipMultiplierUsed: tipMultiplierForThisAttempt,
            matchedPattern: matchedPattern ?? null,
            scheduleExhausted,
          },
          matchedPattern
            ? `Live sell terminal failure (matched "${matchedPattern}") — closing trade as realized loss`
            : `Live sell terminal failure (exhausted ${MAX_SELL_ATTEMPTS_BEFORE_TERMINAL}-attempt schedule) — closing trade as realized loss`,
        );
        // Pass measuredExitSlippagePct=0 so closeTrade routes through the
        // live-overhead branch (deducts entry tip + tx fees + ATA rent from
        // net_profit_sol). exit_price_sol=0 yields a -100% raw return before
        // overhead — the realized loss when the position can't be sold.
        this.tradeLogger.closeTrade({
          tradeId: pos.tradeId,
          entryPriceSol: pos.entryPriceSol,
          exitPriceSol: 0,
          exitReason: 'sell_failed_terminal',
          tradeSizeSol: config.tradeSizeSol,
          takeProfitPct: config.takeProfitPct,
          stopLossPct: config.stopLossPct,
          slGapPenaltyPct: config.slGapPenaltyPct,
          tpGapPenaltyPct: config.tpGapPenaltyPct,
          executionMode,
          measuredExitSlippagePct: 0,
          executionFailureReason: `sell_terminal: ${errMsg}`,
        });
        return;
      }

      // Non-terminal — schedule the next attempt with NO explicit backoff.
      // The position-manager's poll cadence (pollIntervalSec) is the effective
      // floor on retry rate; an explicit backoff on top would only further
      // slow things down. Slippage + tip escalation per the schedule does the
      // work of letting retries succeed (vs. waiting for chain conditions to
      // change). nextSellAttemptAt is intentionally omitted — the next poll
      // tick will fire the retry as soon as it lands.
      const nextSlippageBps = sellSlippageBpsForAttempt(attemptNumber + 1);
      const nextTipMultiplier = sellTipMultiplierForAttempt(attemptNumber + 1);
      logger.error(
        {
          tradeId: pos.tradeId, mint: pos.mint, mode: executionMode,
          exitReason, exitPriceSol,
          attemptJustFailed: attemptNumber,
          slippageBpsUsed: slippageBpsForThisAttempt,
          tipMultiplierUsed: tipMultiplierForThisAttempt,
          nextSlippageBps,
          nextTipMultiplier,
          errorMessage: errMsg,
        },
        `Live sell attempt ${attemptNumber}/${MAX_SELL_ATTEMPTS_BEFORE_TERMINAL} failed — next: slip ${nextSlippageBps} bps, tip ${nextTipMultiplier}×`,
      );
      positionManager.addPosition({ ...pos, sellRetryCount: attemptNumber });
      return;
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
      executionFailureReason: !sellResult.success
        ? (sellResult as { errorMessage?: string }).errorMessage ?? 'unknown'
        : undefined,
    });
  }

  private async recoverOpenPositions(): Promise<void> {
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

      // Wallet validation: if the bot crashed after a successful sell but
      // before closeTrade committed, OR if the operator manually sold the
      // tokens elsewhere, the wallet is empty but the DB still says open.
      // Re-adding the position would loop forever in the indefinite-retry
      // path (commit 6158b1a) since liveSell would keep returning "no
      // tokens in wallet". Close as a realized terminal loss instead — the
      // tokens are gone, the buy cost is sunk, surface it in net_profit_sol.
      // 2026-05-26: switched from failTrade (which hid the loss outside any
      // strategy's P&L) to closeTrade with sell_failed_terminal.
      const walletBal = this.wallet && this.connection
        ? await this.wallet.getTokenBalanceRaw(this.connection, new PublicKey(trade.mint)).catch(() => null)
        : null;
      if (walletBal !== null && walletBal === 0) {
        logger.warn(
          { tradeId: trade.id, mint: trade.mint, strategyId },
          'Recovery: wallet empty but trade row open — closing as terminal loss',
        );
        this.tradeLogger.closeTrade({
          tradeId: trade.id,
          entryPriceSol: trade.entry_effective_price ?? trade.entry_price_sol,
          exitPriceSol: 0,
          exitReason: 'sell_failed_terminal',
          tradeSizeSol: trade.trade_size_sol,
          takeProfitPct: trade.take_profit_pct,
          stopLossPct: trade.stop_loss_pct,
          slGapPenaltyPct: instance.config.slGapPenaltyPct,
          tpGapPenaltyPct: instance.config.tpGapPenaltyPct,
          executionMode: trade.execution_mode ?? 'live_full',
          measuredExitSlippagePct: 0,
          executionFailureReason: 'recovery_wallet_empty',
        });
        continue;
      }
      // Prefer actual on-chain balance over DB value — covers the edge case
      // where recordEntryFill stored a placeholder (recovery position from
      // the buy-side ATA propagation fix, executor.ts liveBuy).
      const tokensHeldRaw = walletBal != null && walletBal > 0
        ? walletBal / 1e6
        : (trade.entry_tokens_received ?? 0);

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
        tokensHeld: tokensHeldRaw,
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
        markovFilterKey: instance.markovFilterKey,
      });
      logger.info(
        { tradeId: trade.id, strategyId, tokensHeld: tokensHeldRaw, walletChecked: walletBal !== null },
        'Live position recovered for monitoring',
      );
    }
  }
}
