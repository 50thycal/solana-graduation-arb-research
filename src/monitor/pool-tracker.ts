import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';
import { PriceCollector, ObservationContext } from '../collector/price-collector';

const logger = pino({ name: 'pool-tracker' });

// PumpSwap program ID
const PUMPSWAP_PROGRAM_ID = new PublicKey(
  process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);
const PUMPSWAP_PROGRAM_STR = PUMPSWAP_PROGRAM_ID.toBase58();

interface PendingGraduation {
  graduationId: number;
  mint: string;
  bondingCurveAddress: string;
  bondingCurvePrice: number;
  graduationTimestamp: number;
  addedAt: number;
}

const PENDING_TTL_MS = 300_000; // 5 minutes
const CLEANUP_INTERVAL_MS = 30_000;

export class PoolTracker {
  private db: Database.Database;
  private connection: Connection;
  private priceCollector: PriceCollector;
  private pumpSwapSubId: number | null = null;
  private pendingByMint: Map<string, PendingGraduation> = new Map();
  private pendingByCurve: Map<string, PendingGraduation> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private totalPoolsFound = 0;
  private totalExpired = 0;
  private totalSkipped = 0;
  private totalPumpSwapEvents = 0;
  private totalMatched = 0;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
    this.priceCollector = new PriceCollector(db, connection);
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
    this.priceCollector.updateConnection(connection);
    this.resubscribe();
  }

  getStats() {
    return {
      pending: this.pendingByMint.size,
      totalPoolsFound: this.totalPoolsFound,
      totalExpired: this.totalExpired,
      totalSkipped: this.totalSkipped,
      totalPumpSwapEvents: this.totalPumpSwapEvents,
      totalMatched: this.totalMatched,
      pumpSwapSubscribed: this.pumpSwapSubId !== null,
      priceCollector: this.priceCollector.getStats(),
    };
  }

  async start(): Promise<void> {
    await this.subscribeToPumpSwap();
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    logger.info('Pool tracker started with PumpSwap log subscription');
  }

  trackGraduation(
    graduationId: number,
    mint: string,
    bondingCurveAddress: string,
    bondingCurvePrice: number,
    graduationTimestamp: number
  ): void {
    const maxPending = parseInt(process.env.MAX_CONCURRENT_OBSERVATIONS || '100', 10);

    if (this.pendingByMint.size >= maxPending) {
      this.totalSkipped++;
      if (this.totalSkipped % 50 === 1) {
        logger.warn(
          { graduationId, pending: this.pendingByMint.size, totalSkipped: this.totalSkipped },
          'Max pending graduations reached'
        );
      }
      return;
    }

    const entry: PendingGraduation = {
      graduationId,
      mint,
      bondingCurveAddress,
      bondingCurvePrice,
      graduationTimestamp,
      addedAt: Date.now(),
    };

    this.pendingByMint.set(mint, entry);
    if (bondingCurveAddress) {
      this.pendingByCurve.set(bondingCurveAddress, entry);
    }

    logger.info(
      { graduationId, mint, pending: this.pendingByMint.size },
      'Tracking graduation for pool migration'
    );
  }

  stop(): void {
    if (this.pumpSwapSubId !== null) {
      this.connection.removeOnLogsListener(this.pumpSwapSubId).catch(() => {});
      this.pumpSwapSubId = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.priceCollector.stop();
    this.pendingByMint.clear();
    this.pendingByCurve.clear();
  }

  private async subscribeToPumpSwap(): Promise<void> {
    try {
      this.pumpSwapSubId = this.connection.onLogs(
        PUMPSWAP_PROGRAM_ID,
        async (logs: Logs, ctx: Context) => {
          this.totalPumpSwapEvents++;

          if (this.totalPumpSwapEvents <= 5) {
            logger.info(
              {
                signature: logs.signature,
                slot: ctx.slot,
                logCount: logs.logs.length,
                totalEvents: this.totalPumpSwapEvents,
              },
              'PumpSwap log event'
            );
          }

          if (logs.err) return;
          if (this.pendingByMint.size === 0) return;

          try {
            await this.handlePumpSwapEvent(logs.signature, ctx.slot);
          } catch (err) {
            logger.error(
              'Error handling PumpSwap event %s: %s',
              logs.signature,
              err instanceof Error ? err.message : String(err)
            );
          }
        },
        'confirmed'
      );

      logger.info(
        { subscriptionId: this.pumpSwapSubId, programId: PUMPSWAP_PROGRAM_STR },
        'Subscribed to PumpSwap logs'
      );
    } catch (err) {
      logger.error(
        'Failed to subscribe to PumpSwap logs: %s',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async resubscribe(): Promise<void> {
    if (this.pumpSwapSubId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.pumpSwapSubId);
      } catch {}
      this.pumpSwapSubId = null;
    }
    await this.subscribeToPumpSwap();
  }

  private async handlePumpSwapEvent(signature: string, slot: number): Promise<void> {
    const tx = await this.fetchParsedTransaction(signature);
    if (!tx || !tx.meta || tx.meta.err) return;

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === 'string' ? k : k.pubkey.toBase58()
    );

    let matched: PendingGraduation | undefined;
    let matchedBy = '';

    for (const key of accountKeys) {
      if (this.pendingByMint.has(key)) {
        matched = this.pendingByMint.get(key)!;
        matchedBy = 'mint';
        break;
      }
      if (this.pendingByCurve.has(key)) {
        matched = this.pendingByCurve.get(key)!;
        matchedBy = 'bonding-curve';
        break;
      }
    }

    if (!matched) return;

    this.totalMatched++;

    const poolAddress = this.extractPoolAddress(tx, PUMPSWAP_PROGRAM_STR);

    if (!poolAddress) {
      logger.warn(
        { signature, mint: matched.mint, matchedBy },
        'PumpSwap tx matched but could not extract pool address'
      );
      return;
    }

    const migrationTimestamp = tx.blockTime || Math.floor(Date.now() / 1000);

    // Record the pool in the graduations table
    updateGraduationPool(
      this.db,
      matched.graduationId,
      poolAddress,
      'pumpswap',
      signature,
      slot,
      migrationTimestamp
    );

    this.totalPoolsFound++;

    const searchTimeMs = Date.now() - matched.addedAt;

    logger.info(
      {
        graduationId: matched.graduationId,
        mint: matched.mint,
        poolAddress,
        matchedBy,
        searchTimeMs,
        totalFound: this.totalPoolsFound,
      },
      'Pool found via PumpSwap subscription'
    );

    // Remove from pending maps
    this.pendingByMint.delete(matched.mint);
    if (matched.bondingCurveAddress) {
      this.pendingByCurve.delete(matched.bondingCurveAddress);
    }

    // START PRICE OBSERVATION (Phase 2)
    const obsCtx: ObservationContext = {
      graduationId: matched.graduationId,
      mint: matched.mint,
      poolAddress,
      poolDex: 'pumpswap',
      bondingCurvePrice: matched.bondingCurvePrice,
      graduationTimestamp: matched.graduationTimestamp,
      migrationTimestamp,
    };

    this.priceCollector.startObservation(obsCtx);
  }

  private extractPoolAddress(tx: any, dexProgramId: string): string | null {
    for (const ix of tx.transaction.message.instructions) {
      if (!('programId' in ix)) continue;
      const progId = typeof ix.programId === 'string'
        ? ix.programId
        : ix.programId.toBase58();

      if (progId === dexProgramId && 'accounts' in ix && Array.isArray(ix.accounts)) {
        const accts = ix.accounts;
        if (accts.length > 0) {
          const addr = typeof accts[0] === 'string' ? accts[0] : accts[0]?.toBase58?.();
          if (addr) return addr;
        }
      }
    }

    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (!('programId' in ix)) continue;
          const progId = typeof ix.programId === 'string'
            ? ix.programId
            : ix.programId.toBase58();

          if (progId === dexProgramId && 'accounts' in ix && Array.isArray(ix.accounts)) {
            const accts = ix.accounts;
            if (accts.length > 0) {
              const addr = typeof accts[0] === 'string' ? accts[0] : accts[0]?.toBase58?.();
              if (addr) return addr;
            }
          }
        }
      }
    }

    return null;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const expiredMints: string[] = [];

    for (const [mint, entry] of this.pendingByMint) {
      if (now - entry.addedAt > PENDING_TTL_MS) {
        expiredMints.push(mint);
      }
    }

    for (const mint of expiredMints) {
      const entry = this.pendingByMint.get(mint)!;
      this.pendingByMint.delete(mint);
      if (entry.bondingCurveAddress) {
        this.pendingByCurve.delete(entry.bondingCurveAddress);
      }
      this.totalExpired++;
    }

    if (expiredMints.length > 0 && this.totalExpired % 20 === 0) {
      logger.info(
        { expired: expiredMints.length, totalExpired: this.totalExpired, pending: this.pendingByMint.size },
        'Cleaned up expired pending graduations'
      );
    }
  }

  private async fetchParsedTransaction(signature: string, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.connection.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch (err) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500));
        } else {
          return null;
        }
      }
    }
    return null;
  }
}
