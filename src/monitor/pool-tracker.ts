import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';

const logger = pino({ name: 'pool-tracker' });

// Known DEX program IDs
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

// PumpSwap program ID — configurable via env
const PUMPSWAP_PROGRAM_ID =
  process.env.PUMPSWAP_PROGRAM_ID || 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP';

const DEX_PROGRAM_IDS = new Set([
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  PUMPSWAP_PROGRAM_ID,
]);

interface TrackedGraduation {
  graduationId: number;
  mint: string;
  graduationTimestamp: number;
  startedAt: number;
  lastCheckedSignature?: string;
}

const POOL_SEARCH_TIMEOUT_MS = 120_000; // Stop looking after 2 minutes
const POLL_INTERVAL_MS = 3_000; // Check every 3s (reduced from 2s to lower RPC load)

export class PoolTracker {
  private db: Database.Database;
  private connection: Connection;
  private tracked: Map<number, TrackedGraduation> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private polling = false;

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
    // Prevent overlapping polls
    if (this.polling) return;
    this.polling = true;

    try {
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
    } finally {
      this.polling = false;
    }
  }

  private async findPool(
    graduation: TrackedGraduation
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Fetch only recent signatures for this mint (single RPC call instead of 20+ getParsedTransaction calls)
    const signatures = await this.connection.getSignaturesForAddress(
      new PublicKey(graduation.mint),
      {
        limit: 10,
        ...(graduation.lastCheckedSignature
          ? { until: graduation.lastCheckedSignature }
          : {}),
      }
    );

    if (signatures.length === 0) return null;

    // Remember the newest signature so next poll only checks new txs
    graduation.lastCheckedSignature = signatures[0].signature;

    // Check each signature for DEX pool creation
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

        // Check if any DEX program is involved
        const matchedDex = accountKeys.find((key) => DEX_PROGRAM_IDS.has(key));
        if (!matchedDex) continue;

        // Determine which DEX
        let dex: string;
        if (matchedDex === PUMPSWAP_PROGRAM_ID) {
          dex = 'pumpswap';
        } else if (matchedDex === RAYDIUM_CPMM_PROGRAM) {
          dex = 'raydium-cpmm';
        } else {
          dex = 'raydium-amm';
        }

        // Find the pool address from the DEX instruction accounts
        for (const ix of tx.transaction.message.instructions) {
          if ('programId' in ix) {
            const progId =
              typeof ix.programId === 'string'
                ? ix.programId
                : ix.programId.toBase58();
            if (DEX_PROGRAM_IDS.has(progId)) {
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
      } catch (err) {
        logger.debug({ err, signature: sigInfo.signature }, 'Failed to parse tx');
        continue;
      }
    }

    return null;
  }
}
