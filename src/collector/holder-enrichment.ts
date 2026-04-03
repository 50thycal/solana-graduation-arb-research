import { Connection, PublicKey } from '@solana/web3.js';
import pino from 'pino';
import { globalRpcLimiter } from '../utils/rpc-limiter';

// SPL Token program — all token accounts are owned by this program
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// SPL token account byte size (used as dataSize filter)
const SPL_ACCOUNT_SIZE = 165;
// Holder count cap — above this we report the cap and set holderCountCapped=true
const HOLDER_COUNT_CAP = 500;

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'holder-enrichment' });

// pump.fun tokens have 1 billion total supply with 6 decimals
const PUMP_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000; // 10^15

export interface EnrichmentResult {
  holderCount: number;
  holderCountCapped: boolean; // true when true count >= HOLDER_COUNT_CAP (500)
  top5WalletPct: number;
  devWalletPct: number;
  tokenAgeSeconds?: number;
}


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
   * Get the creation blockTime of the bonding curve PDA.
   *
   * The BC is a deterministic PDA (derived from the mint) that is created when the
   * token launches and closed at graduation — so its signature list is finite and
   * much smaller than the mint's (which appears in every token transfer).
   *
   * We walk to the oldest signature without throttleOrDrop: this is a critical
   * data point and is called after the busy graduation window, so a direct await
   * is fine.
   */
  async getBondingCurveCreationTime(bcPubkey: PublicKey): Promise<number | null> {
    let before: string | undefined = undefined;
    let oldestBlockTime: number | null = null;
    const MAX_PAGES = 3; // 3 000 txns — covers all but the most actively-traded tokens

    for (let page = 0; page < MAX_PAGES; page++) {
      const sigs: Array<{ signature: string; blockTime?: number | null }> =
        await this.connection.getSignaturesForAddress(bcPubkey, {
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
      holderCountCapped: false,
      top5WalletPct: 0,
      devWalletPct: 0,
    };

    // ── TRUE HOLDER COUNT via getProgramAccounts ──────────────────────────────
    // getTokenLargestAccounts is capped at 20 results (19 real after infra),
    // making it useless as a filter. Instead we enumerate ALL token accounts
    // for this mint using getProgramAccounts with:
    //   • dataSize: 165 — only SPL token accounts (not mints or multisigs)
    //   • memcmp offset 0 — the mint address is the first 32 bytes of an SPL
    //     token account's data layout
    //   • dataSlice {0, 0} — we only need the count, not the account data
    // This can be slow for tokens with thousands of holders, so we cap at 500.
    try {
      if (!await globalRpcLimiter.throttleOrDrop(15)) {
        logger.debug({ mint: mint.slice(0, 8) }, 'True holder count dropped — RPC queue full');
      } else {
        const mintPubkey = new PublicKey(mint);
        const allTokenAccounts = await this.connection.getProgramAccounts(
          TOKEN_PROGRAM_ID,
          {
            commitment: 'confirmed',
            dataSlice: { offset: 0, length: 0 }, // no data — just count results
            filters: [
              { dataSize: SPL_ACCOUNT_SIZE },
              { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
            ],
          }
        );

        const rawCount = allTokenAccounts.length;
        if (rawCount >= HOLDER_COUNT_CAP) {
          result.holderCount = HOLDER_COUNT_CAP;
          result.holderCountCapped = true;
        } else {
          result.holderCount = rawCount;
          result.holderCountCapped = false;
        }

        logger.debug(
          { mint: mint.slice(0, 8), rawCount, capped: result.holderCountCapped },
          'True holder count from getProgramAccounts'
        );
      }
    } catch (err) {
      logger.warn(
        { mint: mint.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
        'getProgramAccounts holder count failed — falling back to getTokenLargestAccounts'
      );
      // Fallback: getTokenLargestAccounts gives at most 19 real holders.
      // Set capped=true whenever we hit that ceiling so downstream analysis
      // knows the number is a floor, not an exact count.
      try {
        if (await globalRpcLimiter.throttleOrDrop(10)) {
          const largestAccounts = await this.connection.getTokenLargestAccounts(
            new PublicKey(mint),
            'confirmed'
          );
          if (largestAccounts.value && largestAccounts.value.length > 0) {
            const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
            const realHolders = largestAccounts.value.filter((acc) => {
              const amt = parseInt(acc.amount, 10) || 0;
              return amt > 0 && amt < INFRA_THRESHOLD;
            });
            result.holderCount = realHolders.length;
            // 19 = max real holders from this method (20 minus 1 infra).
            // Flag as capped so filters know "19" means "at least 19".
            result.holderCountCapped = realHolders.length >= 19;
          }
        }
      } catch (fallbackErr) {
        logger.warn(
          { mint: mint.slice(0, 8) },
          'Fallback holder count also failed: %s',
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        );
      }
    }

    // ── TOP 5 / DEV WALLET CONCENTRATION via getTokenLargestAccounts ─────────
    // We still need balances for concentration metrics, so a separate call is
    // required regardless of the true holder count method above.
    try {
      if (!await globalRpcLimiter.throttleOrDrop(10)) {
        logger.debug({ mint: mint.slice(0, 8) }, 'Concentration enrichment dropped — RPC queue full');
      } else {
        const largestAccounts = await this.connection.getTokenLargestAccounts(
          new PublicKey(mint),
          'confirmed'
        );

        if (largestAccounts.value && largestAccounts.value.length > 0) {
          const sorted = [...largestAccounts.value].sort((a, b) => {
            const aAmt = parseInt(a.amount, 10) || 0;
            const bAmt = parseInt(b.amount, 10) || 0;
            return bAmt - aAmt;
          });

          // Filter out the pool vault (>15% of supply) and zero-balance accounts
          const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
          const realHolders = sorted.filter((acc) => {
            const amt = parseInt(acc.amount, 10) || 0;
            return amt > 0 && amt < INFRA_THRESHOLD;
          });

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
        { mint: mint.slice(0, 8) },
        'Concentration enrichment failed: %s',
        err instanceof Error ? err.message : String(err)
      );
    }

    // Token age: always attempt independently of holder enrichment success/failure.
    // This is required for the velocity filter (bc_velocity_sol_per_min).
    // We query the bonding curve address (not the mint) — the BC is closed at
    // graduation so its signature list is finite and much smaller than the mint's.
    if (graduationBlockTime && bondingCurveAddress) {
      try {
        const creationTime = await this.getBondingCurveCreationTime(new PublicKey(bondingCurveAddress));
        if (creationTime !== null) {
          // Minimum 1s: tokens sniped in the same block as creation have diff=0.
          result.tokenAgeSeconds = Math.max(1, graduationBlockTime - creationTime);
          logger.info(
            { mint: mint.slice(0, 8), tokenAgeSeconds: result.tokenAgeSeconds },
            'Token age resolved from bonding curve history'
          );
        } else {
          logger.warn({ mint: mint.slice(0, 8) }, 'Could not determine bonding curve creation time');
        }
      } catch (ageErr) {
        logger.warn(
          { mint: mint.slice(0, 8) },
          'Token age lookup failed: %s',
          ageErr instanceof Error ? ageErr.message : String(ageErr)
        );
      }
    }

    logger.debug(
      {
        mint: mint.slice(0, 8),
        holderCount: result.holderCount,
        holderCountCapped: result.holderCountCapped,
        top5Pct: result.top5WalletPct.toFixed(1),
        devPct: result.devWalletPct.toFixed(1),
        ageSecs: result.tokenAgeSeconds ?? 'unknown',
      },
      'Holder enrichment complete'
    );

    return result;
  }
}
