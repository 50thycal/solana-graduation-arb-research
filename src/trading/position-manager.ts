import { EventEmitter } from 'events';
import { Connection } from '@solana/web3.js';
import { fetchVaultPrice } from './executor';
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
  /** Unix seconds of graduation detection — used by match_collection mode to
   *  align price checks with SNAPSHOT_SCHEDULE. Falls back to entryTimestamp-30. */
  graduationDetectedAt: number;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'timeout';

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

  // match_collection mode: per-position scheduled timeout handles
  private positionTimers: Map<number, NodeJS.Timeout[]> = new Map();

  constructor(private readonly monitorMode: 'five_second' | 'match_collection' = 'five_second') {
    super();
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
    const gradTimeMs = pos.graduationDetectedAt * 1000;
    const timers: NodeJS.Timeout[] = [];

    for (const offset of COLLECTION_CHECK_OFFSETS) {
      const checkAtMs = gradTimeMs + offset * 1000;
      const delayMs = checkAtMs - nowMs;
      if (delayMs < 100) continue;                               // already past
      if (checkAtMs > pos.maxExitTimestamp * 1000) continue;    // after max hold

      timers.push(setTimeout(() => {
        this.checkPosition(pos.tradeId).catch(err => {
          logger.error('checkPosition error for trade %d: %s', pos.tradeId, err instanceof Error ? err.message : String(err));
        });
      }, delayMs));
    }

    // Guaranteed exit check 1s after maxExitTimestamp (catches timeout even if no
    // collection offsets land exactly at maxExitTimestamp)
    const timeoutDelayMs = pos.maxExitTimestamp * 1000 - nowMs + 1000;
    if (timeoutDelayMs > 0) {
      timers.push(setTimeout(() => {
        this.checkPosition(pos.tradeId).catch(err => {
          logger.error('timeout check error for trade %d: %s', pos.tradeId, err instanceof Error ? err.message : String(err));
        });
      }, timeoutDelayMs));
    }

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

    if (now >= pos.maxExitTimestamp) {
      const r = await this.tryFetchPrice(pos);
      const exitPrice = r?.priceSol ?? pos.entryPriceSol;
      this.triggerExit(pos, 'timeout', exitPrice);
      return;
    }

    const r = await this.tryFetchPrice(pos);
    if (!r) return; // RPC unavailable — skip this tick

    const { priceSol } = r;

    if (priceSol >= pos.tpPriceSol) {
      this.triggerExit(pos, 'take_profit', priceSol);
    } else if (priceSol <= pos.slPriceSol) {
      this.triggerExit(pos, 'stop_loss', priceSol);
    }
  }

  private async tryFetchPrice(pos: ActivePosition): Promise<{ priceSol: number } | null> {
    try {
      return await fetchVaultPrice(this.connection!, pos.baseVault, pos.quoteVault);
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
        returnPct: (((exitPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100).toFixed(2),
      },
      'Position exit triggered'
    );

    this.emit('exit', event);
  }
}
