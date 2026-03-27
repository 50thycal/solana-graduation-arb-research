import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';
import { PriceCollector, ObservationContext } from '../collector/price-collector';
import { globalRpcLimiter } from '../utils/rpc-limiter';

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

// Lightweight entry added immediately after tx parse — before bonding curve verification.
// Lets us catch PumpSwap pool creation that fires during the verification window.
interface SpeculativeEntry {
  mint: string;
  bondingCurveAddress: string;
  addedAt: number;
}

interface PreFoundPool {
  address: string;
  signature: string;
  slot: number;
  migrationTimestamp: number;
  addedAt: number;
  baseVault?: string;
  quoteVault?: string;
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
  private speculativeByMint: Map<string, SpeculativeEntry> = new Map();
  private speculativeByCurve: Map<string, SpeculativeEntry> = new Map();
  // Pool found during speculative window — waiting for graduation confirmation
  private preFoundByMint: Map<string, PreFoundPool> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private totalPoolsFound = 0;
  private totalExpired = 0;
  private totalSkipped = 0;
  private totalPumpSwapEvents = 0;
  private totalPoolCreationEvents = 0;
  private totalMatched = 0;
  private totalSpeculativeHits = 0;

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
      speculative: this.speculativeByMint.size,
      preFound: this.preFoundByMint.size,
      totalPoolsFound: this.totalPoolsFound,
      totalExpired: this.totalExpired,
      totalSkipped: this.totalSkipped,
      totalPumpSwapEvents: this.totalPumpSwapEvents,
      totalPoolCreationEvents: this.totalPoolCreationEvents,
      totalMatched: this.totalMatched,
      totalSpeculativeHits: this.totalSpeculativeHits,
      pumpSwapSubscribed: this.pumpSwapSubId !== null,
      priceCollector: this.priceCollector.getStats(),
    };
  }

  async start(): Promise<void> {
    await this.subscribeToPumpSwap();
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    logger.info('Pool tracker started with PumpSwap log subscription');
  }

  /**
   * Called immediately after the graduation tx is parsed — before bonding curve verification.
   * Ensures the mint is visible to PumpSwap matching during the ~300ms verification window.
   */
  speculativeTrack(mint: string, bondingCurveAddress: string): void {
    if (this.pendingByMint.has(mint) || this.speculativeByMint.has(mint)) return;
    const entry: SpeculativeEntry = { mint, bondingCurveAddress, addedAt: Date.now() };
    this.speculativeByMint.set(mint, entry);
    if (bondingCurveAddress && !PoolTracker.isWellKnownAddress(bondingCurveAddress)) {
      this.speculativeByCurve.set(bondingCurveAddress, entry);
    }
  }

  // Addresses that must never be used as curve-match keys — they appear in every tx
  private static isWellKnownAddress(addr: string): boolean {
    return addr === '11111111111111111111111111111111' || // system program
      addr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || // token program
      addr === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv'; // associated token program
  }

  /** Called when graduation verification fails — remove from speculative and preFound. */
  cancelSpeculative(mint: string): void {
    const entry = this.speculativeByMint.get(mint);
    if (entry) {
      this.speculativeByMint.delete(mint);
      if (entry.bondingCurveAddress) {
        this.speculativeByCurve.delete(entry.bondingCurveAddress);
      }
    }
    this.preFoundByMint.delete(mint);
  }

  trackGraduation(
    graduationId: number,
    mint: string,
    bondingCurveAddress: string,
    bondingCurvePrice: number,
    graduationTimestamp: number
  ): void {
    // Remove from speculative maps now that graduation is confirmed
    const speculative = this.speculativeByMint.get(mint);
    if (speculative) {
      this.speculativeByMint.delete(mint);
      if (speculative.bondingCurveAddress) {
        this.speculativeByCurve.delete(speculative.bondingCurveAddress);
      }
    }

    // If PumpSwap already found the pool during the speculative window, fire immediately
    const preFound = this.preFoundByMint.get(mint);
    if (preFound) {
      this.preFoundByMint.delete(mint);
      this.totalMatched++;
      this.totalPoolsFound++;
      this.totalSpeculativeHits++;

      updateGraduationPool(this.db, graduationId, preFound.address, 'pumpswap', preFound.signature, preFound.slot, preFound.migrationTimestamp);

      logger.info(
        { graduationId, mint, poolAddress: preFound.address, searchTimeMs: Date.now() - preFound.addedAt },
        'Pool matched via speculative pre-track (pool found before graduation confirmed)'
      );

      this.priceCollector.startObservation({
        graduationId,
        mint,
        poolAddress: preFound.address,
        poolDex: 'pumpswap',
        bondingCurvePrice,
        graduationTimestamp,
        migrationTimestamp: preFound.migrationTimestamp,
        baseVault: preFound.baseVault,
        quoteVault: preFound.quoteVault,
      });
      return;
    }

    // MAX_PENDING_GRADUATIONS caps the in-memory pending map (just mint strings, zero RPC cost).
    // This is separate from MAX_CONCURRENT_OBSERVATIONS which limits active price observation sessions.
    const maxPending = parseInt(process.env.MAX_PENDING_GRADUATIONS || '200', 10);

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
    if (bondingCurveAddress && !PoolTracker.isWellKnownAddress(bondingCurveAddress)) {
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
    this.speculativeByMint.clear();
    this.speculativeByCurve.clear();
    this.preFoundByMint.clear();
  }

  private async subscribeToPumpSwap(): Promise<void> {
    try {
      this.pumpSwapSubId = this.connection.onLogs(
        PUMPSWAP_PROGRAM_ID,
        async (logs: Logs, ctx: Context) => {
          this.totalPumpSwapEvents++;

          if (logs.err) return;
          if (this.pendingByMint.size === 0 && this.speculativeByMint.size === 0) return;

          // CRITICAL: PumpSwap handles thousands of swap events per minute.
          // Only fetch the full transaction for pool creation events, not swaps.
          // Use narrow signals: the pump.fun migration CPI is the most reliable,
          // plus the explicit "create_pool" instruction name. Avoid broad matches
          // like "Create"/"Initialize" which fire on every swap that creates an ATA.
          const isPoolCreation = logs.logs.some(
            (log) =>
              log.includes('create_pool') ||
              log.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') // pump.fun program in migration CPI
          );

          if (!isPoolCreation) return;

          this.totalPoolCreationEvents++;

          // Log first few pool creation events for debugging
          if (this.totalPoolCreationEvents <= 10) {
            logger.info(
              {
                signature: logs.signature,
                slot: ctx.slot,
                logCount: logs.logs.length,
                logs: logs.logs.slice(0, 8),
                totalCreationEvents: this.totalPoolCreationEvents,
                totalSwapEvents: this.totalPumpSwapEvents,
              },
              'PumpSwap pool creation event'
            );
          }

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
    let speculativeMatch: SpeculativeEntry | undefined;

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
      if (this.speculativeByMint.has(key)) {
        speculativeMatch = this.speculativeByMint.get(key)!;
        matchedBy = 'mint-speculative';
        break;
      }
      if (this.speculativeByCurve.has(key)) {
        speculativeMatch = this.speculativeByCurve.get(key)!;
        matchedBy = 'curve-speculative';
        break;
      }
    }

    // Speculative match: remove from matchable maps immediately to prevent re-matching
    // on subsequent swap events, then store pool in preFoundByMint for trackGraduation to pick up
    if (!matched && speculativeMatch) {
      const poolInfo = this.extractPoolInfo(tx, PUMPSWAP_PROGRAM_STR);
      if (poolInfo) {
        this.speculativeByMint.delete(speculativeMatch.mint);
        if (speculativeMatch.bondingCurveAddress) {
          this.speculativeByCurve.delete(speculativeMatch.bondingCurveAddress);
        }
        this.preFoundByMint.set(speculativeMatch.mint, {
          address: poolInfo.poolAddress,
          signature,
          slot,
          migrationTimestamp: tx.blockTime || Math.floor(Date.now() / 1000),
          addedAt: speculativeMatch.addedAt,
          baseVault: poolInfo.baseVault,
          quoteVault: poolInfo.quoteVault,
        });
        logger.info(
          { mint: speculativeMatch.mint, poolAddress: poolInfo.poolAddress, baseVault: poolInfo.baseVault, matchedBy },
          'Pool found speculatively — waiting for graduation confirmation'
        );
      }
      return;
    }

    if (!matched) return;

    this.totalMatched++;

    const poolInfo = this.extractPoolInfo(tx, PUMPSWAP_PROGRAM_STR);

    if (!poolInfo) {
      logger.warn(
        { signature, mint: matched.mint, matchedBy },
        'PumpSwap tx matched but could not extract pool address'
      );
      return;
    }

    const { poolAddress, baseVault, quoteVault } = poolInfo;
    const migrationTimestamp = tx.blockTime || Math.floor(Date.now() / 1000);

    updateGraduationPool(this.db, matched.graduationId, poolAddress, 'pumpswap', signature, slot, migrationTimestamp);

    this.totalPoolsFound++;

    logger.info(
      {
        graduationId: matched.graduationId,
        mint: matched.mint,
        poolAddress,
        baseVault,
        matchedBy,
        searchTimeMs: Date.now() - matched.addedAt,
        totalFound: this.totalPoolsFound,
      },
      'Pool found via PumpSwap subscription'
    );

    this.pendingByMint.delete(matched.mint);
    if (matched.bondingCurveAddress) {
      this.pendingByCurve.delete(matched.bondingCurveAddress);
    }

    this.priceCollector.startObservation({
      graduationId: matched.graduationId,
      mint: matched.mint,
      poolAddress,
      poolDex: 'pumpswap',
      bondingCurvePrice: matched.bondingCurvePrice,
      graduationTimestamp: matched.graduationTimestamp,
      migrationTimestamp,
      baseVault,
      quoteVault,
    });
  }

  // PumpSwap create_pool instruction account layout:
  //   [0] pool (PDA)          ← pool address
  //   [8] pool_base_token_account  ← base vault (graduated token)
  //   [9] pool_quote_token_account ← quote vault (wSOL)
  private extractPoolInfo(
    tx: any,
    dexProgramId: string
  ): { poolAddress: string; baseVault?: string; quoteVault?: string } | null {
    const toStr = (acct: any): string | null => {
      if (typeof acct === 'string') return acct;
      return acct?.toBase58?.() ?? null;
    };

    const parseIx = (ix: any) => {
      if (!('programId' in ix)) return null;
      const progId = typeof ix.programId === 'string' ? ix.programId : ix.programId.toBase58();
      if (progId !== dexProgramId) return null;
      if (!('accounts' in ix) || !Array.isArray(ix.accounts)) return null;

      const accts = ix.accounts;
      const poolAddress = toStr(accts[0]);
      if (!poolAddress) return null;

      // create_pool account layout (PumpSwap IDL):
      // [0] pool, [6] user_base, [7] user_quote, [8] user_pool_lp,
      // [9] pool_base_token_account (base vault), [10] pool_quote_token_account (quote vault)
      return {
        poolAddress,
        baseVault: accts.length > 9 ? toStr(accts[9]) ?? undefined : undefined,
        quoteVault: accts.length > 10 ? toStr(accts[10]) ?? undefined : undefined,
      };
    };

    for (const ix of tx.transaction.message.instructions) {
      const result = parseIx(ix);
      if (result) return result;
    }

    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          const result = parseIx(ix);
          if (result) return result;
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

    // Speculative and preFound entries expire after 30s
    const SPECULATIVE_TTL_MS = 30_000;
    for (const [mint, entry] of this.speculativeByMint) {
      if (now - entry.addedAt > SPECULATIVE_TTL_MS) {
        this.speculativeByMint.delete(mint);
        if (entry.bondingCurveAddress) {
          this.speculativeByCurve.delete(entry.bondingCurveAddress);
        }
      }
    }
    for (const [mint, entry] of this.preFoundByMint) {
      if (now - entry.addedAt > SPECULATIVE_TTL_MS) {
        this.preFoundByMint.delete(mint);
      }
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
        await globalRpcLimiter.throttlePriority();
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
