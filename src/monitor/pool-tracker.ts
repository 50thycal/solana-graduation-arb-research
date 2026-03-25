import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';

const logger = pino({ name: 'pool-tracker' });

// PumpSwap program ID
const PUMPSWAP_PROGRAM_ID =
  process.env.PUMPSWAP_PROGRAM_ID || 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP';

// Known DEX program IDs
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

const DEX_PROGRAM_IDS = new Set([
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  PUMPSWAP_PROGRAM_ID,
]);

interface TrackedGraduation {
  graduationId: number;
  mint: string;
  bondingCurveAddress: string;
  graduationTimestamp: number;
  startedAt: number;
  pollCount: number;
}

const POOL_SEARCH_TIMEOUT_MS = 120_000; // 2 minutes
const POLL_INTERVAL_MS = 5_000;

export class PoolTracker {
  private db: Database.Database;
  private connection: Connection;
  private tracked: Map<number, TrackedGraduation> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private polling = false;
  private totalPoolsFound = 0;
  private totalTimeouts = 0;
  private totalSkipped = 0;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  getStats() {
    return {
      tracking: this.tracked.size,
      totalPoolsFound: this.totalPoolsFound,
      totalTimeouts: this.totalTimeouts,
      totalSkipped: this.totalSkipped,
    };
  }

  trackGraduation(
    graduationId: number,
    mint: string,
    bondingCurveAddress: string,
    graduationTimestamp: number
  ): void {
    const maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_OBSERVATIONS || '20',
      10
    );

    if (this.tracked.size >= maxConcurrent) {
      this.totalSkipped++;
      if (this.totalSkipped % 50 === 1) {
        logger.warn(
          { graduationId, tracking: this.tracked.size, totalSkipped: this.totalSkipped },
          'Max concurrent observations reached'
        );
      }
      return;
    }

    this.tracked.set(graduationId, {
      graduationId,
      mint,
      bondingCurveAddress,
      graduationTimestamp,
      startedAt: Date.now(),
      pollCount: 0,
    });

    logger.info(
      { graduationId, mint, tracking: this.tracked.size },
      'Tracking graduation for pool creation'
    );

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.pollForPools(), POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.tracked.clear();
  }

  private async pollForPools(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const now = Date.now();
      const doneIds: number[] = [];

      for (const [id, graduation] of this.tracked) {
        if (now - graduation.startedAt > POOL_SEARCH_TIMEOUT_MS) {
          this.totalTimeouts++;
          if (this.totalTimeouts % 20 === 1) {
            logger.info(
              { graduationId: id, mint: graduation.mint, totalTimeouts: this.totalTimeouts },
              'Pool search timed out'
            );
          }
          doneIds.push(id);
          continue;
        }

        graduation.pollCount++;

        try {
          const pool = await this.findPool(graduation);
          if (pool) {
            updateGraduationPool(
              this.db,
              id,
              pool.address,
              pool.dex,
              pool.signature,
              pool.slot,
              pool.timestamp
            );

            this.totalPoolsFound++;

            logger.info(
              {
                graduationId: id,
                mint: graduation.mint,
                poolAddress: pool.address,
                dex: pool.dex,
                pollCount: graduation.pollCount,
                searchTimeMs: now - graduation.startedAt,
                totalFound: this.totalPoolsFound,
                method: pool.method,
              },
              'Pool found and recorded'
            );

            doneIds.push(id);
          }
        } catch (err) {
          logger.error(
            'Error searching for pool (grad %d): %s',
            id,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      for (const id of doneIds) {
        this.tracked.delete(id);
      }

      if (this.tracked.size === 0 && this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    } finally {
      this.polling = false;
    }
  }

  private async findPool(
    graduation: TrackedGraduation
  ): Promise<{
    address: string;
    dex: string;
    method: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Strategy 1: Search mint's recent transactions for DEX programs
    const mintResult = await this.searchAddressForPool(
      graduation.mint,
      graduation,
      'mint-tx'
    );
    if (mintResult) return mintResult;

    // Strategy 2: Search bonding curve's recent transactions
    // The migration tx often references the bonding curve, not just the mint
    if (graduation.bondingCurveAddress) {
      const curveResult = await this.searchAddressForPool(
        graduation.bondingCurveAddress,
        graduation,
        'curve-tx'
      );
      if (curveResult) return curveResult;
    }

    // Strategy 3: On first poll, also try searching the PumpSwap program directly
    // for recent transactions that reference this mint (via getSignaturesForAddress on PumpSwap)
    if (graduation.pollCount <= 3) {
      const pumpswapResult = await this.searchPumpSwapForMint(graduation);
      if (pumpswapResult) return pumpswapResult;
    }

    return null;
  }

  private async searchAddressForPool(
    address: string,
    graduation: TrackedGraduation,
    method: string
  ): Promise<{
    address: string;
    dex: string;
    method: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit: 15 }
      );

      if (signatures.length === 0) return null;

      for (const sigInfo of signatures) {
        const tx = await this.fetchParsedTransaction(sigInfo.signature);
        if (!tx || !tx.meta || tx.meta.err) continue;

        const dexMatch = this.findDexInTransaction(tx);
        if (!dexMatch) continue;

        const poolAddress = this.extractPoolAddress(tx, dexMatch.programId);
        if (!poolAddress) continue;

        return {
          address: poolAddress,
          dex: dexMatch.dex,
          method,
          signature: sigInfo.signature,
          slot: sigInfo.slot,
          timestamp: tx.blockTime || undefined,
        };
      }
    } catch (err) {
      if (graduation.pollCount <= 2) {
        logger.debug(
          '%s search failed for %s: %s',
          method,
          address.slice(0, 8),
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    return null;
  }

  private async searchPumpSwapForMint(
    graduation: TrackedGraduation
  ): Promise<{
    address: string;
    dex: string;
    method: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    try {
      // Get recent PumpSwap transactions and check if any reference our mint
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(PUMPSWAP_PROGRAM_ID),
        { limit: 30 }
      );

      for (const sigInfo of signatures) {
        const tx = await this.fetchParsedTransaction(sigInfo.signature);
        if (!tx || !tx.meta || tx.meta.err) continue;

        // Check if this PumpSwap tx references our mint
        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );

        if (!accountKeys.includes(graduation.mint)) continue;

        // This PumpSwap tx references our mint — extract pool address
        const poolAddress = this.extractPoolAddress(tx, PUMPSWAP_PROGRAM_ID);
        if (poolAddress) {
          return {
            address: poolAddress,
            dex: 'pumpswap',
            method: 'pumpswap-scan',
            signature: sigInfo.signature,
            slot: sigInfo.slot,
            timestamp: tx.blockTime || undefined,
          };
        }
      }
    } catch (err) {
      logger.debug(
        'PumpSwap scan failed for %s: %s',
        graduation.mint.slice(0, 8),
        err instanceof Error ? err.message : String(err)
      );
    }

    return null;
  }

  private findDexInTransaction(tx: any): { programId: string; dex: string } | null {
    // Check top-level account keys
    const accountKeys = tx.transaction.message.accountKeys.map((k: any) =>
      typeof k === 'string' ? k : k.pubkey.toBase58()
    );

    for (const key of accountKeys) {
      if (DEX_PROGRAM_IDS.has(key)) {
        return { programId: key, dex: this.dexName(key) };
      }
    }

    // Check inner instructions for CPI-based DEX calls
    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (!('programId' in ix)) continue;
          const progId = typeof ix.programId === 'string'
            ? ix.programId
            : ix.programId.toBase58();
          if (DEX_PROGRAM_IDS.has(progId)) {
            return { programId: progId, dex: this.dexName(progId) };
          }
        }
      }
    }

    return null;
  }

  private dexName(programId: string): string {
    if (programId === PUMPSWAP_PROGRAM_ID) return 'pumpswap';
    if (programId === RAYDIUM_CPMM_PROGRAM) return 'raydium-cpmm';
    if (programId === RAYDIUM_AMM_PROGRAM) return 'raydium-amm';
    return 'unknown';
  }

  private extractPoolAddress(tx: any, dexProgramId: string): string | null {
    // Check top-level instructions
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

    // Check inner instructions
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
