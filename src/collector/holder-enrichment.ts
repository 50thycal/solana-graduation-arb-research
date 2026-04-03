import { Connection, PublicKey } from '@solana/web3.js';
import pino from 'pino';
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'holder-enrichment' });

// pump.fun tokens have 1 billion total supply with 6 decimals
const PUMP_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000; // 10^15

export interface EnrichmentResult {
  holderCount: number;
  top5WalletPct: number;
  devWalletPct: number;
  tokenAgeSeconds?: number;
}

const MAX_AGE_PAGES = 5; // max pages of 1000 sigs to walk back (covers ~5000 txns)

export class HolderEnrichment {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Fetch holder concentration data for a token at graduation time.
   * Uses getTokenLargestAccounts (1 RPC call) to get top 20 holders.
   * Excludes known infrastructure addresses (bonding curve, pool vaults).
   */
  /**
   * Walk back through signatures on the mint address to find its creation blockTime.
   * Paginates oldest-first by following `before` pointers. Capped at MAX_AGE_PAGES.
   */
  async getMintCreationTime(mintPubkey: PublicKey): Promise<number | null> {
    let before: string | undefined = undefined;
    let oldestBlockTime: number | null = null;

    for (let page = 0; page < MAX_AGE_PAGES; page++) {
      if (!await globalRpcLimiter.throttleOrDrop(15)) break;

      const sigs: Array<{ signature: string; blockTime?: number | null }> =
        await this.connection.getSignaturesForAddress(mintPubkey, {
          limit: 1000,
          before,
        });

      if (sigs.length === 0) break;

      const last = sigs[sigs.length - 1] as { signature: string; blockTime?: number | null };
      if (last.blockTime) oldestBlockTime = last.blockTime;

      if (sigs.length < 1000) break; // reached the beginning
      before = last.signature;
    }

    return oldestBlockTime;
  }

  async enrich(
    mint: string,
    bondingCurveAddress: string,
    graduationBlockTime?: number,
    poolAddress?: string
  ): Promise<EnrichmentResult> {
    const result: EnrichmentResult = {
      holderCount: 0,
      top5WalletPct: 0,
      devWalletPct: 0,
    };

    // Holder count / concentration — may fail due to RPC errors or invalid mint address.
    // Isolated in its own try/catch so failures don't block the token age fetch below.
    try {
      if (!await globalRpcLimiter.throttleOrDrop(10)) {
        logger.debug({ mint: mint.slice(0, 8) }, 'Holder enrichment dropped — RPC queue full');
      } else {
        const largestAccounts = await this.connection.getTokenLargestAccounts(
          new PublicKey(mint),
          'confirmed'
        );

        if (largestAccounts.value && largestAccounts.value.length > 0) {
          // Filter out infrastructure accounts (bonding curve ATA, pool vault)
          // These aren't real "holders" — they're program-controlled accounts
          const infraAddresses = new Set<string>();

          // We don't have the exact ATA addresses, but we can identify them by
          // their large balances. At graduation, bonding curve has ~0 tokens,
          // pool vault has ~207M tokens. We filter by checking if the owner
          // is a known program. For now, we use all accounts as-is and rely
          // on the fact that at graduation the bonding curve is near-empty.

          const accounts = largestAccounts.value;

          // Sort by amount descending (should already be sorted, but ensure)
          const sorted = [...accounts].sort((a, b) => {
            const aAmt = parseInt(a.amount, 10) || 0;
            const bAmt = parseInt(b.amount, 10) || 0;
            return bAmt - aAmt;
          });

          // Filter out the pool vault — it holds ~207M tokens (20.7% of supply)
          // and the bonding curve ATA (near-zero at graduation but may still appear).
          // Heuristic: any account holding >15% of supply is likely infrastructure.
          const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
          const realHolders = sorted.filter((acc) => {
            const amt = parseInt(acc.amount, 10) || 0;
            return amt > 0 && amt < INFRA_THRESHOLD;
          });

          result.holderCount = realHolders.length;

          // Top 5 holder concentration (excluding infrastructure)
          const top5Amount = realHolders.slice(0, 5).reduce((sum, acc) => {
            return sum + (parseInt(acc.amount, 10) || 0);
          }, 0);
          result.top5WalletPct = (top5Amount / PUMP_TOTAL_SUPPLY_RAW) * 100;

          // Dev wallet heuristic: largest non-infrastructure holder
          if (realHolders.length > 0) {
            const largestAmt = parseInt(realHolders[0].amount, 10) || 0;
            result.devWalletPct = (largestAmt / PUMP_TOTAL_SUPPLY_RAW) * 100;
          }
        }
      }
    } catch (err) {
      logger.warn(
        'Holder enrichment failed for %s: %s',
        mint.slice(0, 8),
        err instanceof Error ? err.message : String(err)
      );
    }

    // Token age: always attempt independently of holder enrichment success/failure.
    // This is required for the velocity filter (bc_velocity_sol_per_min) and must
    // not be gated on getTokenLargestAccounts succeeding.
    if (graduationBlockTime) {
      try {
        const creationTime = await this.getMintCreationTime(new PublicKey(mint));
        if (creationTime !== null) {
          result.tokenAgeSeconds = Math.max(0, graduationBlockTime - creationTime);
        }
      } catch (ageErr) {
        logger.debug({ mint: mint.slice(0, 8) }, 'Could not determine token age');
      }
    }

    logger.debug(
      {
        mint: mint.slice(0, 8),
        holderCount: result.holderCount,
        top5Pct: result.top5WalletPct.toFixed(1),
        devPct: result.devWalletPct.toFixed(1),
        ageSecs: result.tokenAgeSeconds ?? 'unknown',
      },
      'Holder enrichment complete'
    );

    return result;
  }
}
