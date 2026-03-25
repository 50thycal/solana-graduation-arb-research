import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';

const logger = pino({ name: 'pool-tracker' });

// Known DEX program IDs
const RAYDIUM_AMM_PROGRAM = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
);
const RAYDIUM_CPMM_PROGRAM = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
);

// PumpSwap program ID — configurable via env
const PUMPSWAP_PROGRAM_ID = process.env.PUMPSWAP_PROGRAM_ID
  ? new PublicKey(process.env.PUMPSWAP_PROGRAM_ID)
  : null;

interface TrackedGraduation {
  graduationId: number;
  mint: string;
  graduationTimestamp: number;
  startedAt: number;
}

const POOL_SEARCH_TIMEOUT_MS = 120_000; // Stop looking after 2 minutes
const POLL_INTERVAL_MS = 2_000;

export class PoolTracker {
  private db: Database.Database;
  private connection: Connection;
  private tracked: Map<number, TrackedGraduation> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
  }

  trackGraduation(
    graduationId: number,
    mint: string,
    graduationTimestamp: number
  ): void {
    const maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_OBSERVATIONS || '5',
      10
    );

    if (this.tracked.size >= maxConcurrent) {
      logger.warn(
        { graduationId, mint, currentlyTracking: this.tracked.size },
        'Max concurrent observations reached, skipping'
      );
      return;
    }

    this.tracked.set(graduationId, {
      graduationId,
      mint,
      graduationTimestamp,
      startedAt: Date.now(),
    });

    logger.info(
      { graduationId, mint, tracking: this.tracked.size },
      'Tracking graduation for pool creation'
    );

    // Start polling if not already running
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
    const now = Date.now();
    const expiredIds: number[] = [];

    for (const [id, graduation] of this.tracked) {
      // Check timeout
      if (now - graduation.startedAt > POOL_SEARCH_TIMEOUT_MS) {
        logger.info(
          { graduationId: id, mint: graduation.mint },
          'Pool search timed out'
        );
        expiredIds.push(id);
        continue;
      }

      try {
        const pool = await this.findPool(graduation.mint);
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

          logger.info(
            {
              graduationId: id,
              mint: graduation.mint,
              poolAddress: pool.address,
              dex: pool.dex,
            },
            'Pool found and recorded'
          );

          expiredIds.push(id);
        }
      } catch (err) {
        logger.error(
          { err, graduationId: id, mint: graduation.mint },
          'Error searching for pool'
        );
      }
    }

    // Clean up expired/found entries
    for (const id of expiredIds) {
      this.tracked.delete(id);
    }

    // Stop polling if nothing left to track
    if (this.tracked.size === 0 && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async findPool(
    mint: string
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    const mintPubkey = new PublicKey(mint);

    // Check for Raydium AMM pool
    try {
      const raydiumPool = await this.findRaydiumPool(mintPubkey);
      if (raydiumPool) return raydiumPool;
    } catch {
      // continue to next check
    }

    // Check for PumpSwap pool if program ID is configured
    if (PUMPSWAP_PROGRAM_ID) {
      try {
        const pumpswapPool = await this.findPumpSwapPool(mintPubkey);
        if (pumpswapPool) return pumpswapPool;
      } catch {
        // continue
      }
    }

    return null;
  }

  private async findRaydiumPool(
    mint: PublicKey
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Look for token accounts associated with the Raydium AMM that hold this mint
    // This uses getTokenAccountsByOwner which is more efficient than scanning all pools
    const signatures = await this.connection.getSignaturesForAddress(mint, {
      limit: 20,
    });

    for (const sigInfo of signatures) {
      try {
        const tx = await this.connection.getParsedTransaction(
          sigInfo.signature,
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }
        );

        if (!tx || !tx.meta || tx.meta.err) continue;

        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );

        // Check if this transaction involves Raydium
        const isRaydium = accountKeys.some(
          (key) =>
            key === RAYDIUM_AMM_PROGRAM.toBase58() ||
            key === RAYDIUM_CPMM_PROGRAM.toBase58()
        );

        if (isRaydium) {
          // Look for the pool account in the instruction accounts
          for (const ix of tx.transaction.message.instructions) {
            if ('programId' in ix) {
              const progId =
                typeof ix.programId === 'string'
                  ? ix.programId
                  : ix.programId.toBase58();
              if (
                progId === RAYDIUM_AMM_PROGRAM.toBase58() ||
                progId === RAYDIUM_CPMM_PROGRAM.toBase58()
              ) {
                const dex =
                  progId === RAYDIUM_CPMM_PROGRAM.toBase58()
                    ? 'raydium-cpmm'
                    : 'raydium-amm';

                // The pool address is typically the first account in the instruction
                const accounts = (ix as any).accounts as PublicKey[];
                if (accounts && accounts.length > 0) {
                  return {
                    address: accounts[0].toBase58(),
                    dex,
                    signature: sigInfo.signature,
                    slot: sigInfo.slot,
                    timestamp: tx.blockTime || undefined,
                  };
                }
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async findPumpSwapPool(
    mint: PublicKey
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    if (!PUMPSWAP_PROGRAM_ID) return null;

    const signatures = await this.connection.getSignaturesForAddress(mint, {
      limit: 20,
    });

    for (const sigInfo of signatures) {
      try {
        const tx = await this.connection.getParsedTransaction(
          sigInfo.signature,
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }
        );

        if (!tx || !tx.meta || tx.meta.err) continue;

        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );

        const isPumpSwap = accountKeys.some(
          (key) => key === PUMPSWAP_PROGRAM_ID!.toBase58()
        );

        if (isPumpSwap) {
          for (const ix of tx.transaction.message.instructions) {
            if ('programId' in ix) {
              const progId =
                typeof ix.programId === 'string'
                  ? ix.programId
                  : ix.programId.toBase58();
              if (progId === PUMPSWAP_PROGRAM_ID!.toBase58()) {
                const accounts = (ix as any).accounts as PublicKey[];
                if (accounts && accounts.length > 0) {
                  return {
                    address: accounts[0].toBase58(),
                    dex: 'pumpswap',
                    signature: sigInfo.signature,
                    slot: sigInfo.slot,
                    timestamp: tx.blockTime || undefined,
                  };
                }
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}
