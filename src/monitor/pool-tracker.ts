import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import Database from 'better-sqlite3';
import pino from 'pino';
import { updateGraduationPool } from '../db/queries';

const logger = pino({ name: 'pool-tracker' });

// PumpSwap program ID
const PUMPSWAP_PROGRAM_ID =
  process.env.PUMPSWAP_PROGRAM_ID || 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP';

// Known DEX program IDs for identification
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

const DEX_PROGRAM_IDS = new Set([
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  PUMPSWAP_PROGRAM_ID,
]);

// SOL mint for Jupiter quotes
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface TrackedGraduation {
  graduationId: number;
  mint: string;
  graduationTimestamp: number;
  startedAt: number;
  pollCount: number;
  jupiterAttempted: boolean;
}

const POOL_SEARCH_TIMEOUT_MS = 180_000; // 3 minutes — migration can take a bit
const POLL_INTERVAL_MS = 5_000; // Check every 5s

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

  updateConnection(connection: Connection): void {
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
      pollCount: 0,
      jupiterAttempted: false,
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
      const expiredIds: number[] = [];

      for (const [id, graduation] of this.tracked) {
        if (now - graduation.startedAt > POOL_SEARCH_TIMEOUT_MS) {
          logger.warn(
            { graduationId: id, mint: graduation.mint, pollCount: graduation.pollCount },
            'Pool search timed out'
          );
          expiredIds.push(id);
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

            logger.info(
              {
                graduationId: id,
                mint: graduation.mint,
                poolAddress: pool.address,
                dex: pool.dex,
                pollCount: graduation.pollCount,
                searchTimeMs: now - graduation.startedAt,
              },
              'Pool found and recorded'
            );

            expiredIds.push(id);
          }
        } catch (err) {
          logger.error(
            'Error searching for pool (grad %d, mint %s): %s',
            id,
            graduation.mint,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      for (const id of expiredIds) {
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
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Strategy 1: Use Jupiter API to find the pool (most reliable)
    // Jupiter discovers new pools quickly — if it returns a route, the pool exists
    const jupiterResult = await this.findPoolViaJupiter(graduation);
    if (jupiterResult) return jupiterResult;

    // Strategy 2: Look for PumpSwap migration transaction via the mint's recent txs
    // The migration tx references both the mint and PumpSwap program
    const migrationResult = await this.findPoolViaMigrationTx(graduation);
    if (migrationResult) return migrationResult;

    return null;
  }

  private async findPoolViaJupiter(
    graduation: TrackedGraduation
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Don't spam Jupiter on every poll — try after 5s, then every 15s
    const elapsed = Date.now() - graduation.startedAt;
    if (elapsed < 5_000) return null;
    if (graduation.jupiterAttempted && graduation.pollCount % 3 !== 0) return null;
    graduation.jupiterAttempted = true;

    try {
      // Query Jupiter for a quote: SOL -> token mint
      const response = await axios.get('https://quote-api.jup.ag/v6/quote', {
        params: {
          inputMint: SOL_MINT,
          outputMint: graduation.mint,
          amount: '100000000', // 0.1 SOL in lamports
          slippageBps: '500',
        },
        timeout: 5_000,
      });

      if (!response.data || !response.data.routePlan || response.data.routePlan.length === 0) {
        return null;
      }

      // Extract pool info from the route
      const routePlan = response.data.routePlan;
      const firstSwap = routePlan[0]?.swapInfo;

      if (!firstSwap || !firstSwap.ammKey) return null;

      // Determine DEX from the route label
      const label = (firstSwap.label || '').toLowerCase();
      let dex = 'unknown';
      if (label.includes('pumpswap') || label.includes('pump')) {
        dex = 'pumpswap';
      } else if (label.includes('raydium')) {
        dex = label.includes('cpmm') ? 'raydium-cpmm' : 'raydium-amm';
      } else if (label.includes('orca')) {
        dex = 'orca';
      } else {
        dex = label || 'unknown';
      }

      logger.info(
        {
          mint: graduation.mint,
          ammKey: firstSwap.ammKey,
          label: firstSwap.label,
          dex,
        },
        'Pool found via Jupiter'
      );

      return {
        address: firstSwap.ammKey,
        dex,
      };
    } catch (err) {
      // Jupiter returns 400 if no route exists — that's expected early on
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        return null;
      }
      logger.debug(
        'Jupiter quote failed for %s: %s',
        graduation.mint,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  private async findPoolViaMigrationTx(
    graduation: TrackedGraduation
  ): Promise<{
    address: string;
    dex: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Only check via RPC every other poll to save credits
    if (graduation.pollCount % 2 !== 0) return null;

    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(graduation.mint),
        { limit: 10 }
      );

      if (signatures.length === 0) return null;

      for (const sigInfo of signatures) {
        const tx = await this.fetchParsedTransaction(sigInfo.signature);
        if (!tx || !tx.meta || tx.meta.err) continue;

        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );

        // Check if any DEX program is in the transaction
        const matchedDex = accountKeys.find((key) => DEX_PROGRAM_IDS.has(key));
        if (!matchedDex) continue;

        let dex: string;
        if (matchedDex === PUMPSWAP_PROGRAM_ID) {
          dex = 'pumpswap';
        } else if (matchedDex === RAYDIUM_CPMM_PROGRAM) {
          dex = 'raydium-cpmm';
        } else {
          dex = 'raydium-amm';
        }

        // Extract pool address from the DEX instruction
        // Check both top-level and inner instructions
        const poolAddress = this.extractPoolAddress(tx, matchedDex);

        if (poolAddress) {
          logger.info(
            {
              mint: graduation.mint,
              poolAddress,
              dex,
              signature: sigInfo.signature,
            },
            'Pool found via migration tx'
          );

          return {
            address: poolAddress,
            dex,
            signature: sigInfo.signature,
            slot: sigInfo.slot,
            timestamp: tx.blockTime || undefined,
          };
        }
      }
    } catch (err) {
      logger.debug(
        'Migration tx search failed for %s: %s',
        graduation.mint,
        err instanceof Error ? err.message : String(err)
      );
    }

    return null;
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

    // Check inner instructions (migration often happens via CPI)
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

  /** Fetch a parsed transaction with a single retry on failure. */
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
          logger.debug(
            'Failed to fetch tx %s: %s',
            signature,
            err instanceof Error ? err.message : String(err)
          );
          return null;
        }
      }
    }
    return null;
  }
}
