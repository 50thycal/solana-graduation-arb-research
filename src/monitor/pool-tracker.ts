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

// Jupiter API endpoints to try (in order)
const JUPITER_ENDPOINTS = [
  'https://quote-api.jup.ag/v6/quote',
  'https://lite-api.jup.ag/v6/quote',
];

interface TrackedGraduation {
  graduationId: number;
  mint: string;
  graduationTimestamp: number;
  startedAt: number;
  pollCount: number;
  jupiterDisabled: boolean;
}

const POOL_SEARCH_TIMEOUT_MS = 120_000; // 2 minutes
const POLL_INTERVAL_MS = 5_000;

export class PoolTracker {
  private db: Database.Database;
  private connection: Connection;
  private tracked: Map<number, TrackedGraduation> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private polling = false;
  private jupiterEndpointIndex = 0;
  private jupiterConsecutiveFailures = 0;
  private jupiterGloballyDisabled = false;
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
      jupiterDisabled: this.jupiterGloballyDisabled,
      jupiterEndpoint: JUPITER_ENDPOINTS[this.jupiterEndpointIndex],
    };
  }

  trackGraduation(
    graduationId: number,
    mint: string,
    graduationTimestamp: number
  ): void {
    const maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_OBSERVATIONS || '20',
      10
    );

    if (this.tracked.size >= maxConcurrent) {
      this.totalSkipped++;
      // Only log every 50th skip to avoid spam
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
      graduationTimestamp,
      startedAt: Date.now(),
      pollCount: 0,
      jupiterDisabled: false,
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
          // Only log every 20th timeout
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
    signature?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    // Strategy 1: Jupiter API (if not globally disabled due to auth issues)
    if (!this.jupiterGloballyDisabled) {
      const jupiterResult = await this.findPoolViaJupiter(graduation);
      if (jupiterResult) return jupiterResult;
    }

    // Strategy 2: Look for migration tx via RPC
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
    if (graduation.jupiterDisabled) return null;

    // Try after 10s, then every 3rd poll
    const elapsed = Date.now() - graduation.startedAt;
    if (elapsed < 10_000) return null;
    if (graduation.pollCount > 3 && graduation.pollCount % 3 !== 0) return null;

    const endpoint = JUPITER_ENDPOINTS[this.jupiterEndpointIndex];

    try {
      const response = await axios.get(endpoint, {
        params: {
          inputMint: SOL_MINT,
          outputMint: graduation.mint,
          amount: '100000000', // 0.1 SOL
          slippageBps: '500',
        },
        timeout: 5_000,
      });

      const data = response.data;

      // Reset failure counter on success
      this.jupiterConsecutiveFailures = 0;

      // Log first response to verify structure
      if (this.totalPoolsFound === 0 && graduation.pollCount <= 4) {
        logger.info(
          {
            mint: graduation.mint,
            responseKeys: data ? Object.keys(data) : [],
            hasRoutePlan: !!data?.routePlan,
            routePlanLength: data?.routePlan?.length,
          },
          'Jupiter quote response structure'
        );
      }

      if (!data || !data.routePlan || data.routePlan.length === 0) {
        return null;
      }

      const firstSwap = data.routePlan[0]?.swapInfo;
      if (!firstSwap || !firstSwap.ammKey) return null;

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

      return { address: firstSwap.ammKey, dex };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;

        if (status === 401 || status === 403) {
          this.jupiterConsecutiveFailures++;

          // Try next endpoint after 3 failures
          if (this.jupiterConsecutiveFailures === 3) {
            const nextIndex = this.jupiterEndpointIndex + 1;
            if (nextIndex < JUPITER_ENDPOINTS.length) {
              this.jupiterEndpointIndex = nextIndex;
              this.jupiterConsecutiveFailures = 0;
              logger.info(
                { newEndpoint: JUPITER_ENDPOINTS[nextIndex] },
                'Switching Jupiter endpoint after auth failures'
              );
            } else {
              // All endpoints failed — disable Jupiter globally
              this.jupiterGloballyDisabled = true;
              logger.warn(
                'All Jupiter endpoints returned auth errors — disabling Jupiter. Will rely on migration tx only.'
              );
            }
          } else if (this.jupiterConsecutiveFailures === 1) {
            // Log only the first failure
            logger.warn(
              { status, endpoint, message: err.response?.data?.error || err.message },
              'Jupiter auth error'
            );
          }
          return null;
        }

        // 400 = no route found — expected, don't log
        if (status === 400) return null;

        // Other errors — log once
        if (graduation.pollCount <= 2) {
          logger.info(
            { status, mint: graduation.mint, message: err.message },
            'Jupiter error'
          );
        }
        return null;
      }

      // Non-axios error
      if (graduation.pollCount <= 2) {
        logger.info(
          'Jupiter failed for %s: %s',
          graduation.mint,
          err instanceof Error ? err.message : String(err)
        );
      }
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
    // Check every poll since this is our primary strategy now
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(graduation.mint),
        { limit: 15 }
      );

      if (signatures.length === 0) return null;

      for (const sigInfo of signatures) {
        const tx = await this.fetchParsedTransaction(sigInfo.signature);
        if (!tx || !tx.meta || tx.meta.err) continue;

        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );

        // Check top-level account keys for DEX programs
        let matchedDex = accountKeys.find((key) => DEX_PROGRAM_IDS.has(key));

        // Also check inner instructions for DEX programs (CPI-based migration)
        if (!matchedDex && tx.meta.innerInstructions) {
          for (const inner of tx.meta.innerInstructions) {
            for (const ix of inner.instructions) {
              if (!('programId' in ix)) continue;
              const progId = typeof ix.programId === 'string'
                ? ix.programId
                : ix.programId.toBase58();
              if (DEX_PROGRAM_IDS.has(progId)) {
                matchedDex = progId;
                break;
              }
            }
            if (matchedDex) break;
          }
        }

        if (!matchedDex) continue;

        let dex: string;
        if (matchedDex === PUMPSWAP_PROGRAM_ID) {
          dex = 'pumpswap';
        } else if (matchedDex === RAYDIUM_CPMM_PROGRAM) {
          dex = 'raydium-cpmm';
        } else {
          dex = 'raydium-amm';
        }

        const poolAddress = this.extractPoolAddress(tx, matchedDex);

        if (poolAddress) {
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
      if (graduation.pollCount <= 2) {
        logger.debug(
          'Migration tx search failed for %s: %s',
          graduation.mint,
          err instanceof Error ? err.message : String(err)
        );
      }
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
