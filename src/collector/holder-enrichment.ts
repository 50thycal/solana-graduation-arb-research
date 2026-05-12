import { Connection, PublicKey } from '@solana/web3.js';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

// SPL Token program — all token accounts are owned by this program
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// SPL token account byte size (used as dataSize filter)
const SPL_ACCOUNT_SIZE = 165;
// Holder count cap — above this we report the cap and set holderCountCapped=true
const HOLDER_COUNT_CAP = 500;

const logger = makeLogger('holder-enrichment');

// pump.fun tokens have 1 billion total supply with 6 decimals
const PUMP_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000; // 10^15

export interface EnrichmentResult {
  holderCount: number;
  holderCountCapped: boolean; // true when true count >= HOLDER_COUNT_CAP (500)
  top5WalletPct: number;
  /** C3 — supply % held by top 10 wallets (subset of getTokenLargestAccounts result). */
  top10WalletPct?: number;
  /** C3 — Gini coefficient across the top 20 wallets, 0 (uniform) to 1 (whale-dominated). */
  walletGiniTop20?: number;
  devWalletPct: number;
  devWalletAddress?: string;       // wallet address of largest non-infrastructure holder
  creatorWalletAddress?: string;   // wallet that deployed the token on pump.fun
  tokenAgeSeconds?: number;
}

/**
 * Gini coefficient across an array of non-negative balances.
 * Formula: (2 * sum(i * x_i) - (N+1) * sum(x_i)) / (N * sum(x_i)) for sorted x_i.
 * Returns 0 for uniform distribution, approaches 1 as concentration increases.
 * Returns null when input is empty or sum is zero (no signal in either case).
 */
function gini(balances: number[]): number | null {
  if (balances.length === 0) return null;
  const sorted = [...balances].sort((a, b) => a - b);
  const n = sorted.length;
  let weightedSum = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * sorted[i];
    total += sorted[i];
  }
  if (total === 0) return null;
  return (2 * weightedSum - (n + 1) * total) / (n * total);
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
  async getBondingCurveCreationTime(bcPubkey: PublicKey): Promise<{ blockTime: number; oldestSignature: string } | null> {
    let before: string | undefined = undefined;
    let oldestBlockTime: number | null = null;
    let oldestSignature: string | null = null;
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
      oldestSignature = last.signature;

      if (sigs.length < 1000) break; // reached the beginning
      before = last.signature;
    }

    if (oldestBlockTime !== null && oldestSignature !== null) {
      return { blockTime: oldestBlockTime, oldestSignature };
    }
    return null;
  }

  /**
   * Resolve the creator (deployer) wallet from the oldest bonding curve transaction.
   * The fee payer / signer of the first BC transaction is the token creator.
   */
  async getCreatorWallet(oldestSignature: string): Promise<string | null> {
    try {
      const tx = await this.connection.getParsedTransaction(oldestSignature, {
        maxSupportedTransactionVersion: 0,
      });
      const signers = tx?.transaction?.message?.accountKeys?.filter((k: any) => k.signer);
      return signers?.[0]?.pubkey?.toBase58() ?? null;
    } catch (err) {
      logger.debug(
        'Failed to resolve creator wallet from sig %s: %s',
        oldestSignature.slice(0, 8),
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
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

    // ── STEP 1: getTokenLargestAccounts (always run first) ───────────────────
    // Cheap call (≤20 accounts), works on all RPC providers.
    // Provides: top5/dev concentration + a guaranteed fallback holder count.
    // holderCount from this path is capped at 19 — will be upgraded in step 2.
    try {
      if (!await globalRpcLimiter.throttleOrDrop(10)) {
        logger.debug({ mint: mint.slice(0, 8) }, 'getTokenLargestAccounts dropped — RPC queue full');
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

          const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
          const realHolders = sorted.filter((acc) => {
            const amt = parseInt(acc.amount, 10) || 0;
            return amt > 0 && amt < INFRA_THRESHOLD;
          });

          // Fallback count — will be overwritten by step 2 if getProgramAccounts works
          result.holderCount = realHolders.length;
          result.holderCountCapped = realHolders.length >= 19;

          // Top 5 holder concentration (requires balances — only available here)
          const top5Amount = realHolders.slice(0, 5).reduce((sum, acc) => {
            return sum + (parseInt(acc.amount, 10) || 0);
          }, 0);
          result.top5WalletPct = (top5Amount / PUMP_TOTAL_SUPPLY_RAW) * 100;

          // C3 — top 10 concentration + Gini across top 20. Reuses the same
          // getTokenLargestAccounts response — zero additional RPC.
          const top10Amount = realHolders.slice(0, 10).reduce((sum, acc) => {
            return sum + (parseInt(acc.amount, 10) || 0);
          }, 0);
          result.top10WalletPct = (top10Amount / PUMP_TOTAL_SUPPLY_RAW) * 100;

          const balances20 = realHolders.slice(0, 20).map(acc => parseInt(acc.amount, 10) || 0);
          const giniVal = gini(balances20);
          result.walletGiniTop20 = giniVal != null ? +giniVal.toFixed(4) : undefined;

          // Dev wallet heuristic: largest non-infrastructure holder
          if (realHolders.length > 0) {
            const largestAmt = parseInt(realHolders[0].amount, 10) || 0;
            result.devWalletPct = (largestAmt / PUMP_TOTAL_SUPPLY_RAW) * 100;

            // Resolve token account → wallet owner address.
            // getTokenLargestAccounts returns token account addresses, not wallet addresses.
            // One additional RPC call to resolve the owner.
            try {
              const parsedAcct = await this.connection.getParsedAccountInfo(
                realHolders[0].address
              );
              const parsed = parsedAcct?.value?.data;
              if (parsed && typeof parsed === 'object' && 'parsed' in parsed) {
                result.devWalletAddress = (parsed as any).parsed?.info?.owner;
              }
            } catch (walletErr) {
              logger.debug(
                { mint: mint.slice(0, 8) },
                'Failed to resolve dev wallet address: %s',
                walletErr instanceof Error ? walletErr.message : String(walletErr)
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn(
        { mint: mint.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
        'getTokenLargestAccounts failed'
      );
    }

    // ── STEP 2: getProgramAccounts — TRUE holder count (best-effort upgrade) ──
    // getTokenLargestAccounts is capped at 20 results (19 real after infra),
    // making the count useless as a filter. This call enumerates ALL SPL token
    // accounts for the mint to get the real number.
    //
    // NOTE: Some RPC providers block getProgramAccounts for TOKEN_PROGRAM_ID.
    // NOTE: dataSlice is intentionally omitted — combining it with dataSize can
    //       cause some RPC nodes to evaluate dataSize against the sliced (0) length
    //       and return 0 results. We accept the 165-byte-per-account payload since
    //       graduation tokens typically have <500 holders (~80KB max).
    // Only overwrites step 1's count if rawCount > 0 (protects against empty result bug).
    try {
      if (!await globalRpcLimiter.throttleOrDrop(15)) {
        logger.debug({ mint: mint.slice(0, 8) }, 'getProgramAccounts holder count dropped — RPC queue full');
      } else {
        const mintPubkey = new PublicKey(mint);
        const allTokenAccounts = await this.connection.getProgramAccounts(
          TOKEN_PROGRAM_ID,
          {
            commitment: 'confirmed',
            // dataSize filter omitted — some RPC providers silently return 0 for
            // dataSize queries on TOKEN_PROGRAM_ID even when memcmp-only works.
            // All SPL token accounts are 165 bytes so non-165 matches are impossible.
            filters: [
              { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
            ],
          }
        );

        const rawCount = allTokenAccounts.length;
        if (rawCount > 0) {
          // Only upgrade if we got a real result — never overwrite step 1 with 0
          result.holderCount = Math.min(rawCount, HOLDER_COUNT_CAP);
          result.holderCountCapped = rawCount >= HOLDER_COUNT_CAP;
          logger.info(
            { mint: mint.slice(0, 8), rawCount, capped: result.holderCountCapped },
            'True holder count from getProgramAccounts'
          );
        } else {
          logger.warn(
            { mint: mint.slice(0, 8) },
            'getProgramAccounts returned 0 accounts — keeping getTokenLargestAccounts count'
          );
        }
      }
    } catch (err) {
      // getProgramAccounts is often blocked by RPC providers for TOKEN_PROGRAM_ID.
      // Step 1's count remains in result — log at debug to avoid log spam.
      logger.debug(
        { mint: mint.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
        'getProgramAccounts unavailable — using getTokenLargestAccounts count'
      );
    }

    // Token age + creator wallet: always attempt independently of holder enrichment.
    // Token age is required for the velocity filter (bc_velocity_sol_per_min).
    // Creator wallet is extracted from the oldest bonding curve transaction.
    if (graduationBlockTime && bondingCurveAddress) {
      try {
        const bcResult = await this.getBondingCurveCreationTime(new PublicKey(bondingCurveAddress));
        if (bcResult !== null) {
          // Minimum 1s: tokens sniped in the same block as creation have diff=0.
          result.tokenAgeSeconds = Math.max(1, graduationBlockTime - bcResult.blockTime);
          logger.info(
            { mint: mint.slice(0, 8), tokenAgeSeconds: result.tokenAgeSeconds },
            'Token age resolved from bonding curve history'
          );

          // Resolve creator wallet from the oldest BC transaction (1 extra RPC call)
          const creator = await this.getCreatorWallet(bcResult.oldestSignature);
          if (creator) {
            result.creatorWalletAddress = creator;
            logger.info(
              { mint: mint.slice(0, 8), creator: creator.slice(0, 8) },
              'Creator wallet resolved'
            );
          }
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
        devAddr: result.devWalletAddress?.slice(0, 8) ?? 'unknown',
        creator: result.creatorWalletAddress?.slice(0, 8) ?? 'unknown',
        ageSecs: result.tokenAgeSeconds ?? 'unknown',
      },
      'Holder enrichment complete'
    );

    return result;
  }
}
