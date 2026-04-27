import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import Database from 'better-sqlite3';
import { updateGraduationPool } from '../db/queries';
import { PriceCollector, ObservationContext } from '../collector/price-collector';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('pool-tracker');

// PumpSwap program ID
const PUMPSWAP_PROGRAM_ID = new PublicKey(
  process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);
const PUMPSWAP_PROGRAM_STR = PUMPSWAP_PROGRAM_ID.toBase58();

// pump.fun program ID — used to extract pool address from migrate instruction accounts
const PUMP_FUN_PROGRAM_STR = process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

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
  private totalMigrationCandidatesFired = 0;
  private totalMatched = 0;
  private totalSpeculativeHits = 0;
  private migrationCandidateCb: ((sig: string, slot: number, wsReceivedAt: number) => Promise<void>) | null = null;

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
      totalMigrationCandidatesFired: this.totalMigrationCandidatesFired,
      totalMatched: this.totalMatched,
      totalSpeculativeHits: this.totalSpeculativeHits,
      pumpSwapSubscribed: this.pumpSwapSubId !== null,
      priceCollector: this.priceCollector.getStats(),
    };
  }

  /**
   * Register a callback that's invoked for every PumpSwap pool creation event.
   * GraduationListener uses this to run its full migration processing pipeline
   * off the PumpSwap WS, which delivers ~5s vs the pump.fun WS's 30-75s for
   * delayed events. The callback is responsible for dedupe (signature-based).
   */
  setMigrationCandidateCallback(cb: (sig: string, slot: number, wsReceivedAt: number) => Promise<void>): void {
    this.migrationCandidateCb = cb;
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
        bondingCurveAddress,
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

          // CRITICAL: PumpSwap handles thousands of swap events per minute.
          // Only act on pool creation events. The pump.fun migration CPI is
          // the most reliable signal, plus the explicit "create_pool"
          // instruction name. Avoid broad matches like "Create"/"Initialize"
          // which fire on every swap that creates an ATA.
          const isPoolCreation = logs.logs.some(
            (log) =>
              log.includes('create_pool') ||
              log.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') // pump.fun program in migration CPI
          );

          if (!isPoolCreation) return;

          this.totalPoolCreationEvents++;
          const wsReceivedAt = Date.now();

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

          // PRIMARY DETECTION CHANNEL: fire migration candidate to graduation-listener.
          // PumpSwap WS typically delivers ~5s after the on-chain block, while
          // Helius's pump.fun WS delays ~50% of migrations by 30-75s. The listener
          // dedupes by signature so the slower channel's redelivery is a no-op.
          // Fire-and-forget: don't block the WS handler on the full processing pipeline.
          if (this.migrationCandidateCb) {
            this.totalMigrationCandidatesFired++;
            this.migrationCandidateCb(logs.signature, ctx.slot, wsReceivedAt).catch((err) => {
              logger.error(
                'migrationCandidateCb threw for %s: %s',
                logs.signature,
                err instanceof Error ? err.message : String(err)
              );
            });
          }

          // Existing path: fill in pool address for grads where pump.fun WS fired
          // first (added to pending/speculative) but inline pool extraction failed.
          // Skip when there's nothing to match — the callback above is the new
          // primary path and handles its own pool extraction.
          if (this.pendingByMint.size === 0 && this.speculativeByMint.size === 0) return;

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
    // `this.connection` was just replaced in updateConnection() with a fresh
    // Connection. The old pumpSwapSubId belongs to the old Connection's
    // registry and isn't in the new one — calling removeOnLogsListener with
    // it makes web3.js console.warn about the missing id. The old socket is
    // dead anyway, so just clear local state and resubscribe on the new one.
    this.pumpSwapSubId = null;
    await this.subscribeToPumpSwap();
  }

  /**
   * Build the full account key array for a tx, including ALT-resolved accounts.
   * For v0 transactions, compiled instruction account indices span:
   *   [static keys] + [ALT writable] + [ALT readonly]
   * tx.transaction.message.accountKeys only has the static keys, so indices into
   * the ALT range will be out of bounds unless we append them.
   */
  private static buildFullAccountKeys(tx: any): string[] {
    const toStr = (k: any): string =>
      typeof k === 'string' ? k : k?.pubkey?.toBase58?.() ?? k?.toBase58?.() ?? '';

    const static_ = (tx.transaction.message.accountKeys as any[]).map(toStr);
    const loaded = tx.meta?.loadedAddresses;
    if (!loaded) return static_;

    const writable = (loaded.writable as any[] | undefined ?? []).map(toStr);
    const readonly = (loaded.readonly as any[] | undefined ?? []).map(toStr);
    return [...static_, ...writable, ...readonly];
  }

  private async handlePumpSwapEvent(signature: string, slot: number): Promise<void> {
    const tx = await this.fetchParsedTransaction(signature);
    if (!tx || !tx.meta || tx.meta.err) return;

    // Use full account key list (static + ALT) for matching and instruction decoding
    const accountKeys = PoolTracker.buildFullAccountKeys(tx);

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

    const { poolAddress } = poolInfo;
    const migrationTimestamp = tx.blockTime || Math.floor(Date.now() / 1000);

    updateGraduationPool(this.db, matched.graduationId, poolAddress, 'pumpswap', signature, slot, migrationTimestamp);

    this.totalPoolsFound++;

    // NOTE: Pool-tracker's extractPoolInfo returns unreliable vault addresses for the
    // pfeeUxB6 migration format (wrong pool PDA → vault_parse_fail dataLen=0 on every session).
    // directPriceCollector in graduation-listener handles all cases where vaults can be
    // extracted reliably. Pool-tracker's role is now limited to recording the pool address in
    // the DB for completeness — it does NOT start price collection.

    logger.info(
      {
        graduationId: matched.graduationId,
        mint: matched.mint,
        poolAddress,
        matchedBy,
        searchTimeMs: Date.now() - matched.addedAt,
        totalFound: this.totalPoolsFound,
      },
      'Pool found via PumpSwap subscription — pool address recorded, price collection skipped (directPriceCollector handles this)'
    );

    this.pendingByMint.delete(matched.mint);
    if (matched.bondingCurveAddress) {
      this.pendingByCurve.delete(matched.bondingCurveAddress);
    }
  }

  private static readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  private extractPoolInfo(
    tx: any,
    _dexProgramId: string
  ): { poolAddress: string; baseVault?: string; quoteVault?: string } | null {
    const txAccountKeys: string[] = PoolTracker.buildFullAccountKeys(tx);

    const toStr = (acct: any): string | null => {
      if (typeof acct === 'string') return acct;
      return acct?.toBase58?.() ?? null;
    };

    const resolveAccts = (ix: any): string[] | null => {
      if ('programId' in ix) {
        if (!Array.isArray(ix.accounts)) return null;
        return ix.accounts.map(toStr).filter(Boolean) as string[];
      } else if ('programIdIndex' in ix) {
        const indices: number[] = ix.accountKeyIndexes ?? ix.accounts ?? [];
        return indices.map((i: number) => txAccountKeys[i]).filter(Boolean) as string[];
      }
      return null;
    };

    const progIdOf = (ix: any): string | undefined => {
      if ('programId' in ix) return typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.();
      if ('programIdIndex' in ix) return txAccountKeys[ix.programIdIndex];
      return undefined;
    };

    // PRIMARY: Read pool and vaults directly from the pump.fun migrate instruction.
    // migrate account layout (from official IDL):
    //   [0]=global  [1]=withdraw_authority  [2]=mint  [3]=bonding_curve
    //   [4]=associated_bonding_curve  [5]=user  [6]=system_program  [7]=token_program
    //   [8]=pump_amm  [9]=pool  [10]=pool_authority  [11]=pool_authority_mint_account
    //   [12]=pool_authority_wsol_account  [13]=amm_global_config  [14]=wsol_mint
    //   [15]=lp_mint  [16]=user_pool_token_account  [17]=pool_base_token_account
    //   [18]=pool_quote_token_account  ...
    // Reading from the migrate instruction (always PartiallyDecodedInstruction as top-level)
    // is more reliable than parsing the inner PumpSwap CPI, which Helius may return as
    // ParsedInstruction (no accounts array).
    // Token program addresses — never a valid pool address
    const isTokenProgram = (addr: string) =>
      addr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      addr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

    const tryMigrateIx = (ix: any): { poolAddress: string; baseVault?: string; quoteVault?: string } | null => {
      if (progIdOf(ix) !== PUMP_FUN_PROGRAM_STR) return null;
      const accts = resolveAccts(ix);
      // Migrate instruction has 15+ accounts. Small instructions (buy/sell/etc.) have <15.
      if (!accts || accts.length < 15) return null;

      // Official IDL: [8]=pump_amm (program), [9]=pool (PDA).
      // Alternate IDL (26-acct variant): [8]=metadata_account, [9]=creator, ..., [11]=pool.
      // Strategy: scan [8] then [9] — skip any known program or system address.
      const isInvalidPool = (addr: string) =>
        !addr ||
        isTokenProgram(addr) ||
        PoolTracker.isWellKnownAddress(addr) ||
        addr === PoolTracker.WSOL_MINT ||
        addr === PUMPSWAP_PROGRAM_STR ||
        addr === PUMP_FUN_PROGRAM_STR;

      let poolAddress = accts[8];
      if (isInvalidPool(poolAddress)) poolAddress = accts[9];
      if (isInvalidPool(poolAddress)) return null;

      // Official IDL: [17]=pool_base_token_account (base vault), [18]=pool_quote_token_account (quote vault)
      // Extract these so price-collector can skip pool account decode
      let baseVault: string | undefined;
      let quoteVault: string | undefined;
      if (accts.length >= 19) {
        const bv = accts[17];
        const qv = accts[18];
        if (bv && !isInvalidPool(bv) && qv && !isInvalidPool(qv)) {
          baseVault = bv;
          quoteVault = qv;
        }
      }

      return { poolAddress, baseVault, quoteVault };
    };

    // Check top-level instructions first
    for (const ix of tx.transaction.message.instructions) {
      const result = tryMigrateIx(ix);
      if (result) return result;
    }

    // Check inner instructions (in case migrate is wrapped by another program)
    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          const result = tryMigrateIx(ix);
          if (result) return result;
        }
      }
    }

    // NOTE: We do NOT attempt to extract the pool PDA from the PumpSwap create_pool instruction
    // accounts because for v0 transactions the pool PDA lives in an Address Lookup Table (ALT)
    // and is NOT present in ix.accounts — accounts[0] would be a wrong static account.
    // Vault addresses are found reliably via postTokenBalances in graduation-listener instead.

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
