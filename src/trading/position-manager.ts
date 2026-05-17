import { EventEmitter } from 'events';
import { Connection } from '@solana/web3.js';
import { fetchVaultPrice } from './executor';
import { MarkovMatrixStore } from './markov-matrix';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('position-manager');

// Snapshot schedule offsets (seconds from graduation detection time) that fall
// after T+30 entry. Used in match_collection mode to align position price checks
// with the price collector's own schedule — results are then directly comparable
// to historical Panel 4 simulation data.
const COLLECTION_CHECK_OFFSETS = [35, 40, 45, 50, 55, 60, 90, 120, 150, 180, 240, 300, 600];

export interface ActivePosition {
  tradeId: number;
  graduationId: number;
  mint: string;
  poolAddress: string;
  baseVault: string;
  quoteVault: string;
  entryPriceSol: number;
  entryTimestamp: number;      // unix seconds
  tpPriceSol: number;          // entryPrice * (1 + takeProfitPct/100)
  slPriceSol: number;          // entryPrice * (1 - stopLossPct/100)
  maxExitTimestamp: number;    // unix seconds
  tokensHeld: number;          // 0 in paper mode
  mode: 'paper' | 'live';
  /** Full execution phase at entry — drives exit dispatch in Executor.sell(). */
  executionMode?: 'paper' | 'shadow' | 'live_micro' | 'live_full';
  /** Unix seconds of graduation detection — used by match_collection mode to
   *  align price checks with SNAPSHOT_SCHEDULE. Falls back to entryTimestamp-30. */
  graduationDetectedAt: number;

  // ── Dynamic monitoring runtime state ──────────────────────────────────
  /** Highest price observed since entry. Updated every poll tick. */
  highWaterMark: number;
  /** True once price has risen >= trailingSlActivationPct% above entry */
  trailingSlActive: boolean;
  /** True once price has first reached the fixed TP threshold */
  tpThresholdHit: boolean;
  /** Highest price observed after TP threshold was first hit (for trailing TP) */
  postTpHighWaterMark: number;
  /** The currently effective SL price (dynamically adjusted). Init to slPriceSol. */
  effectiveSlPriceSol: number;
  /** Per-token slippage estimate (%) from graduation_momentum.slippage_est_05sol.
   *  Used by paper mode sell to model realistic exit fill quality. */
  slippageEstPct?: number;
  /** Filter-set key (sorted, " + "-joined filter labels) used to look up the
   *  Markov transition matrix. Set when the strategy registers its filter. */
  markovFilterKey?: string;
  /** Count of consecutive failed live-sell attempts. Incremented by handleExit
   *  when an exit fails and the position is re-armed for retry. After
   *  MAX_SELL_RETRIES the trade is force-failed with manual-intervention
   *  status instead of looping forever burning Jito tips. */
  sellRetryCount?: number;
}

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_stop'
  | 'trailing_tp'
  | 'breakeven_stop'
  | 'timeout'
  | 'markov_exit'
  | 'killswitch';

/** Dynamic monitoring parameters — subset of strategy params needed by PositionManager */
export interface DynamicMonitorParams {
  stopLossPct: number;
  maxHoldSeconds: number;
  trailingSlActivationPct: number;
  trailingSlDistancePct: number;
  slActivationDelaySec: number;
  trailingTpEnabled: boolean;
  trailingTpDropPct: number;
  tightenSlAtPctTime: number;
  tightenSlTargetPct: number;
  tightenSlAtPctTime2: number;
  tightenSlTargetPct2: number;
  breakevenStopPct: number;
  markovExitEnabled: boolean;
  markovExitProbThreshold: number;
  markovHoldProbThreshold: number;
}

export interface ExitEvent {
  position: ActivePosition;
  exitReason: ExitReason;
  exitPriceSol: number;
}

export class PositionManager extends EventEmitter {
  private positions: Map<number, ActivePosition> = new Map(); // key = tradeId
  private pollTimer: NodeJS.Timeout | null = null;
  private connection: Connection | null = null;
  private running = false;
  private polling = false; // guard against concurrent poll() invocations (five_second mode)
  private dynamicParams: DynamicMonitorParams;
  private markovStore: MarkovMatrixStore | null;

  // match_collection mode: per-position scheduled timeout handles
  private positionTimers: Map<number, NodeJS.Timeout[]> = new Map();

  constructor(
    private readonly monitorMode: 'five_second' | 'match_collection' = 'five_second',
    dynamicParams?: DynamicMonitorParams,
    markovStore: MarkovMatrixStore | null = null,
  ) {
    super();
    this.dynamicParams = dynamicParams ?? {
      stopLossPct: 10,
      maxHoldSeconds: 300,
      trailingSlActivationPct: 0,
      trailingSlDistancePct: 5,
      slActivationDelaySec: 0,
      trailingTpEnabled: false,
      trailingTpDropPct: 5,
      tightenSlAtPctTime: 0,
      tightenSlTargetPct: 7,
      tightenSlAtPctTime2: 0,
      tightenSlTargetPct2: 5,
      breakevenStopPct: 0,
      markovExitEnabled: false,
      markovExitProbThreshold: 0.30,
      markovHoldProbThreshold: 0.85,
    };
    this.markovStore = markovStore;
  }

  /** Hot-swap dynamic monitoring params without replacing the manager */
  updateDynamicParams(params: DynamicMonitorParams): void {
    this.dynamicParams = params;
  }

  getDynamicParams(): DynamicMonitorParams {
    return this.dynamicParams;
  }

  activeCount(): number {
    return this.positions.size;
  }

  getPositions(): ActivePosition[] {
    return Array.from(this.positions.values());
  }

  hasPosition(tradeId: number): boolean {
    return this.positions.has(tradeId);
  }

  addPosition(pos: ActivePosition): void {
    this.positions.set(pos.tradeId, pos);
    logger.info(
      {
        tradeId: pos.tradeId,
        mint: pos.mint,
        mode: pos.mode,
        monitorMode: this.monitorMode,
        entryPriceSol: pos.entryPriceSol,
        tpPriceSol: pos.tpPriceSol,
        slPriceSol: pos.slPriceSol,
        effectiveSlPriceSol: pos.effectiveSlPriceSol,
        maxExitTimestamp: new Date(pos.maxExitTimestamp * 1000).toISOString(),
      },
      'Position added'
    );

    // In match_collection mode, schedule per-position checks immediately if
    // start() has already been called (i.e. connection is available).
    // If called before start() (position recovery), start() will schedule them.
    if (this.monitorMode === 'match_collection' && this.running) {
      this.scheduleCollectionChecks(pos);
    }
  }

  removePosition(tradeId: number): void {
    this.positions.delete(tradeId);
    // Clear any scheduled collection-aligned timers for this position
    const timers = this.positionTimers.get(tradeId);
    if (timers) {
      timers.forEach(t => clearTimeout(t));
      this.positionTimers.delete(tradeId);
    }
  }

  start(connection: Connection): void {
    // Fix Issue 1: clear any existing timer before creating a new one to prevent
    // timer leaks when start() is called on an already-running position manager.
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connection = connection;
    this.running = true;

    if (this.monitorMode === 'five_second') {
      // Independent 5s polling — matches the price collector's first-60s snapshot
      // frequency and continues at 5s even after T+60 (more responsive to fast moves).
      this.pollTimer = setInterval(() => {
        this.poll().catch(err => {
          logger.error('Position poll error: %s', err instanceof Error ? err.message : String(err));
        });
      }, 5_000);
      logger.info('Position manager started (five_second mode)');
    } else {
      // match_collection mode: no global interval — schedule per-position timeouts.
      // Handle any positions already in the map (recovered on restart before start()).
      for (const pos of this.positions.values()) {
        this.scheduleCollectionChecks(pos);
      }
      logger.info('Position manager started (match_collection mode)');
    }
  }

  stop(): void {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Clear all per-position timers (match_collection mode)
    for (const timers of this.positionTimers.values()) {
      timers.forEach(t => clearTimeout(t));
    }
    this.positionTimers.clear();

    logger.info('Position manager stopped');
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  // ── five_second mode ────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    // Fix Issue 3: prevent concurrent poll() runs if a prior poll is still
    // awaiting RPC responses when the next interval fires (possible under load).
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollInternal();
    } finally {
      this.polling = false;
    }
  }

  private async pollInternal(): Promise<void> {
    if (this.positions.size === 0 || !this.connection) return;
    for (const [tradeId] of this.positions) {
      await this.checkPosition(tradeId).catch(err => {
        logger.error('checkPosition error for trade %d: %s', tradeId, err instanceof Error ? err.message : String(err));
      });
    }
  }

  // ── match_collection mode ───────────────────────────────────────────────────

  private scheduleCollectionChecks(pos: ActivePosition): void {
    const nowMs = Date.now();
    const maxExitMs = pos.maxExitTimestamp * 1000;

    // Recovery case: position is already past maxExit (bot was down longer than
    // maxHoldSeconds, or trade was added via addPosition during retry after the
    // window closed). Fire a checkPosition immediately so the timeout branch
    // can resolve. Without this the position hangs in the monitoring set
    // forever because all setTimeout calls below would be skipped or have
    // negative delays.
    if (nowMs >= maxExitMs) {
      setImmediate(() => {
        this.checkPosition(pos.tradeId).catch(err => {
          logger.error('recovery-immediate check error for trade %d: %s', pos.tradeId, err instanceof Error ? err.message : String(err));
        });
      });
      this.positionTimers.set(pos.tradeId, []);
      return;
    }

    const gradTimeMs = pos.graduationDetectedAt * 1000;
    const timers: NodeJS.Timeout[] = [];

    for (const offset of COLLECTION_CHECK_OFFSETS) {
      const checkAtMs = gradTimeMs + offset * 1000;
      const delayMs = checkAtMs - nowMs;
      if (delayMs < 100) continue;                               // already past
      if (checkAtMs > maxExitMs) continue;                       // after max hold

      timers.push(setTimeout(() => {
        this.checkPosition(pos.tradeId).catch(err => {
          logger.error('checkPosition error for trade %d: %s', pos.tradeId, err instanceof Error ? err.message : String(err));
        });
      }, delayMs));
    }

    // Guaranteed exit check 1s after maxExitTimestamp. The negative-delay
    // guard is no longer needed — the early return above handles that case.
    const timeoutDelayMs = maxExitMs - nowMs + 1000;
    timers.push(setTimeout(() => {
      this.checkPosition(pos.tradeId).catch(err => {
        logger.error('timeout check error for trade %d: %s', pos.tradeId, err instanceof Error ? err.message : String(err));
      });
    }, timeoutDelayMs));

    this.positionTimers.set(pos.tradeId, timers);

    logger.debug(
      { tradeId: pos.tradeId, scheduledChecks: timers.length },
      'Collection-aligned checks scheduled'
    );
  }

  // ── Shared check logic (used by both modes) ─────────────────────────────────

  private async checkPosition(tradeId: number): Promise<void> {
    const pos = this.positions.get(tradeId);
    if (!pos || !this.connection) return;

    const now = Math.floor(Date.now() / 1000);
    const params = this.dynamicParams;

    // 1. TIMEOUT CHECK (highest priority)
    if (now >= pos.maxExitTimestamp) {
      const r = await this.tryFetchPrice(pos);
      const exitPrice = r?.priceSol ?? pos.entryPriceSol;
      this.triggerExit(pos, 'timeout', exitPrice);
      return;
    }

    // 2. FETCH PRICE
    const r = await this.tryFetchPrice(pos);
    if (!r) return; // RPC unavailable — skip this tick

    const { priceSol } = r;

    // 3. UPDATE HIGH WATER MARK (always, even during SL delay)
    if (priceSol > pos.highWaterMark) {
      pos.highWaterMark = priceSol;
    }

    // 3.5. MARKOV STATE-CONDITIONAL CHECK
    // Look up P(profit at T+300 | filter, age, current bucket) in the matrix.
    // If P_win is decisively low → exit early.
    // If P_win is decisively high AND we're already in the win zone → mark
    // markovHoldActive so a later fixed-TP step doesn't fire (let it trail).
    let markovHoldActive = false;
    if (
      params.markovExitEnabled &&
      this.markovStore &&
      pos.markovFilterKey
    ) {
      const ageSec = now - (pos.graduationDetectedAt || pos.entryTimestamp - 30);
      const curPctFromEntry = ((priceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100;
      const cell = this.markovStore.lookup(pos.markovFilterKey, ageSec, curPctFromEntry);
      if (cell) {
        if (cell.p_win < params.markovExitProbThreshold) {
          logger.info(
            {
              tradeId: pos.tradeId,
              ageSec,
              curPctFromEntry: curPctFromEntry.toFixed(2),
              p_win: cell.p_win,
              cellN: cell.n,
              filterKey: pos.markovFilterKey,
            },
            'Markov exit triggered (P_win below threshold)'
          );
          this.triggerExit(pos, 'markov_exit', priceSol);
          return;
        }
        if (
          cell.p_win > params.markovHoldProbThreshold &&
          curPctFromEntry > 0
        ) {
          markovHoldActive = true;
        }
      }
    }

    // 4. COMPUTE EFFECTIVE SL (layered — each rule can only RAISE the floor)
    // Track which DPM rule raised the floor highest so exit reason is correct.
    let effectiveSl = pos.slPriceSol; // start with the original fixed SL
    let slRaisedBy: 'none' | 'tighten' | 'breakeven' | 'trailing' = 'none';
    const secondsHeld = now - pos.entryTimestamp;

    // 4a. TIME-BASED SL TIGHTENING
    if (params.tightenSlAtPctTime > 0 && params.maxHoldSeconds > 0) {
      const elapsedPct = (secondsHeld / params.maxHoldSeconds) * 100;
      let tightenedSl = -Infinity;
      if (params.tightenSlAtPctTime2 > 0 && elapsedPct >= params.tightenSlAtPctTime2) {
        tightenedSl = pos.entryPriceSol * (1 - params.tightenSlTargetPct2 / 100);
      } else if (elapsedPct >= params.tightenSlAtPctTime) {
        tightenedSl = pos.entryPriceSol * (1 - params.tightenSlTargetPct / 100);
      }
      if (tightenedSl > effectiveSl) {
        effectiveSl = tightenedSl;
        slRaisedBy = 'tighten';
      }
    }

    // 4b. BREAKEVEN STOP (raise floor to entry price)
    if (params.breakevenStopPct > 0) {
      const breakevenActivation = pos.entryPriceSol * (1 + params.breakevenStopPct / 100);
      if (pos.highWaterMark >= breakevenActivation) {
        if (pos.entryPriceSol > effectiveSl) {
          effectiveSl = pos.entryPriceSol;
          slRaisedBy = 'breakeven';
        }
      }
    }

    // 4c. TRAILING STOP-LOSS (raise floor to trail below high water mark)
    if (params.trailingSlActivationPct > 0) {
      const activationPrice = pos.entryPriceSol * (1 + params.trailingSlActivationPct / 100);
      if (pos.highWaterMark >= activationPrice) {
        pos.trailingSlActive = true;
      }
      if (pos.trailingSlActive) {
        const trailingSl = pos.highWaterMark * (1 - params.trailingSlDistancePct / 100);
        if (trailingSl > effectiveSl) {
          effectiveSl = trailingSl;
          slRaisedBy = 'trailing';
        }
      }
    }

    // 4d. Store effective SL on position for dashboard display
    pos.effectiveSlPriceSol = effectiveSl;

    // 5. SL ACTIVATION DELAY CHECK
    let slActive = true;
    if (params.slActivationDelaySec > 0 && secondsHeld < params.slActivationDelaySec) {
      slActive = false;
    }

    // 6. SL EXIT CHECK (only if SL active)
    if (slActive && priceSol <= effectiveSl) {
      let exitReason: ExitReason;
      // Classify based on which DPM rule actually set the effective SL floor
      if (slRaisedBy === 'trailing') {
        exitReason = 'trailing_stop';
      } else if (slRaisedBy === 'breakeven') {
        exitReason = 'breakeven_stop';
      } else if (slRaisedBy === 'tighten') {
        // Time-based SL tightening is a dynamic adjustment — classify as trailing_stop
        // so gap penalties and dashboard display correctly reflect DPM activity
        exitReason = 'trailing_stop';
      } else {
        exitReason = 'stop_loss';
      }
      this.triggerExit(pos, exitReason, priceSol);
      return;
    }

    // 7. TP CHECK
    if (params.trailingTpEnabled) {
      // Trailing TP mode: when price first hits TP, start trailing
      if (priceSol >= pos.tpPriceSol) {
        pos.tpThresholdHit = true;
      }
      if (pos.tpThresholdHit) {
        if (priceSol > pos.postTpHighWaterMark) {
          pos.postTpHighWaterMark = priceSol;
        }
        const dropFromPeak = ((pos.postTpHighWaterMark - priceSol) / pos.postTpHighWaterMark) * 100;
        if (dropFromPeak >= params.trailingTpDropPct) {
          this.triggerExit(pos, 'trailing_tp', priceSol);
          return;
        }
      }
    } else {
      // Fixed TP mode (current behavior). When markovHoldActive, skip the
      // fixed TP exit and let the trade keep running — the next tick will
      // re-check P_win and either exit on a hard SL or another markov decision.
      if (priceSol >= pos.tpPriceSol && !markovHoldActive) {
        this.triggerExit(pos, 'take_profit', priceSol);
        return;
      }
    }
  }

  private async tryFetchPrice(pos: ActivePosition): Promise<{ priceSol: number } | null> {
    try {
      // critical=true: position SL/TP checks must never be silently dropped
      return await fetchVaultPrice(this.connection!, pos.baseVault, pos.quoteVault, true);
    } catch {
      return null;
    }
  }

  private triggerExit(pos: ActivePosition, reason: ExitReason, exitPriceSol: number): void {
    // Remove from map (and clear any remaining timers) before emitting to
    // prevent duplicate exit events.
    this.removePosition(pos.tradeId);

    const event: ExitEvent = { position: pos, exitReason: reason, exitPriceSol };

    logger.info(
      {
        tradeId: pos.tradeId,
        mint: pos.mint,
        reason,
        exitPriceSol,
        entryPriceSol: pos.entryPriceSol,
        baseSl: pos.slPriceSol,
        highWaterMark: pos.highWaterMark,
        effectiveSlPriceSol: pos.effectiveSlPriceSol,
        trailingSlActive: pos.trailingSlActive,
        tpThresholdHit: pos.tpThresholdHit,
        returnPct: (((exitPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100).toFixed(2),
      },
      'Position exit triggered'
    );

    this.emit('exit', event);
  }
}
