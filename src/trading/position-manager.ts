import { EventEmitter } from 'events';
import { Connection } from '@solana/web3.js';
import { fetchVaultPrice } from './executor';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('position-manager');

export interface ActivePosition {
  tradeId: number;
  graduationId: number;
  mint: string;
  poolAddress: string;
  baseVault: string;
  quoteVault: string;
  entryPriceSol: number;
  entryTimestamp: number;  // unix seconds
  tpPriceSol: number;      // entryPrice * (1 + takeProfitPct/100)
  slPriceSol: number;      // entryPrice * (1 - stopLossPct/100)
  maxExitTimestamp: number; // unix seconds
  tokensHeld: number;      // 0 in paper mode
  mode: 'paper' | 'live';
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
  private polling = false; // guard against concurrent poll() invocations
  // Match the price-collector's snapshot schedule (every 5s for the first 60s,
  // every 30s after) so paper trade SL/TP results are directly comparable to
  // the historical Panel 4 simulation. 500ms would catch intra-5s dips that
  // the historical data never saw, biasing paper results toward more SL hits.
  private readonly POLL_INTERVAL_MS = 5_000;

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
        entryPriceSol: pos.entryPriceSol,
        tpPriceSol: pos.tpPriceSol,
        slPriceSol: pos.slPriceSol,
        maxExitTimestamp: new Date(pos.maxExitTimestamp * 1000).toISOString(),
      },
      'Position added'
    );
  }

  removePosition(tradeId: number): void {
    this.positions.delete(tradeId);
  }

  start(connection: Connection): void {
    // Fix Issue 1: clear any existing timer before creating a new one to prevent
    // timer leaks when start() is called on an already-running position manager.
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connection = connection;
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => {
        logger.error('Position poll error: %s', err instanceof Error ? err.message : String(err));
      });
    }, this.POLL_INTERVAL_MS);
    logger.info('Position manager started');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Position manager stopped');
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

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

    const now = Math.floor(Date.now() / 1000);

    for (const [tradeId, pos] of this.positions) {
      // Timeout check first — no RPC needed
      if (now >= pos.maxExitTimestamp) {
        // Use last known price or entry price for timeout
        const lastPrice = await this.tryFetchPrice(pos);
        const exitPrice = lastPrice?.priceSol ?? pos.entryPriceSol;
        this.triggerExit(pos, 'timeout', exitPrice);
        continue;
      }

      const poolState = await this.tryFetchPrice(pos);
      if (!poolState) continue; // skip this tick — RPC unavailable

      const { priceSol } = poolState;

      if (priceSol >= pos.tpPriceSol) {
        this.triggerExit(pos, 'take_profit', priceSol);
      } else if (priceSol <= pos.slPriceSol) {
        this.triggerExit(pos, 'stop_loss', priceSol);
      }
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
    // Remove from map before emitting to prevent duplicate exit events
    this.positions.delete(pos.tradeId);

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
