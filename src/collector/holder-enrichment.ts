import { Connection, PublicKey } from '@solana/web3.js';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

// SPL Token program — all token accounts are owned by this program
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// SPL token account byte size (used as dataSize filter)
const SPL_ACCOUNT_SIZE = 165;
// Holder count cap — above this we report the cap and set holderCountCapped=true.
// DAS getTokenAccounts returns 1000 accounts/page; MAX_DAS_PAGES caps total work.
const HOLDER_COUNT_CAP = 5000;
// Max pages to paginate through DAS getTokenAccounts (1000 accounts each).
// 5 pages = 5000 token accounts — well above any post-graduation pumpfun token.
const MAX_DAS_PAGES = 5;

const logger = makeLogger('holder-enrichment');

// pump.fun tokens have 1 billion total supply with 6 decimals
const PUMP_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000; // 10^15

export interface EnrichmentResult {
  holderCount: number;
  holderCountCapped: boolean; // true when enumeration hit MAX_DAS_PAGES / HOLDER_COUNT_CAP
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

  /**
   * TRUE holder count via Helius DAS `getTokenAccounts` (the canonical, indexed way).
   *
   * Why this and not getProgramAccounts:
   *   - getProgramAccounts on TOKEN_PROGRAM_ID is a full-program scan. Helius (and
   *     most providers) rate-limit, time out, or outright block it — which is why
   *     STEP 2 historically failed and we fell back to the 19-cap from STEP 1.
   *   - getTokenAccounts is served straight from Helius's DAS index: fast, reliable,
   *     paginated (1000 token accounts/page), available on standard plans.
   *
   * Holder definition matches STEP 1: a "real holder" is a unique OWNER wallet whose
   * aggregate balance is > 0 and < INFRA_THRESHOLD (15% of supply) — the threshold
   * excludes the bonding curve / PumpSwap pool vault without needing their addresses.
   * One owner can hold several token accounts, so we aggregate by owner before counting.
   *
   * Returns { count, capped } or null if the endpoint is unavailable / not Helius.
   */
  private async getTrueHolderCountViaDAS(
    mint: string
  ): Promise<{ count: number; capped: boolean } | null> {
    const endpoint = (this.connection as any).rpcEndpoint as string | undefined;
    // DAS getTokenAccounts is a Helius extension — only attempt against a Helius RPC.
    if (!endpoint || !/helius/i.test(endpoint)) {
      return null;
    }

    const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
    const ownerBalances = new Map<string, number>();
    let page = 1;
    let hitPageLimit = false;

    for (; page <= MAX_DAS_PAGES; page++) {
      if (!await globalRpcLimiter.throttleOrDrop(15)) {
        logger.debug({ mint: mint.slice(0, 8), page }, 'DAS getTokenAccounts dropped — RPC queue full');
        return null;
      }

      let json: any;
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'holder-count',
            method: 'getTokenAccounts',
            params: { mint, page, limit: 1000, options: { showZeroBalance: false } },
          }),
        });
        if (!resp.ok) {
          logger.debug({ mint: mint.slice(0, 8), status: resp.status }, 'DAS getTokenAccounts HTTP error');
          return null;
        }
        json = await resp.json();
      } catch (err) {
        logger.debug(
          { mint: mint.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
          'DAS getTokenAccounts fetch failed'
        );
        return null;
      }

      if (json?.error) {
        logger.debug({ mint: mint.slice(0, 8), err: json.error?.message }, 'DAS getTokenAccounts rpc error');
        return null;
      }

      const accounts: any[] = json?.result?.token_accounts ?? [];
      if (accounts.length === 0) break;

      for (const acc of accounts) {
        const amt = typeof acc.amount === 'number' ? acc.amount : parseInt(acc.amount, 10) || 0;
        if (amt <= 0 || !acc.owner) continue;
        ownerBalances.set(acc.owner, (ownerBalances.get(acc.owner) || 0) + amt);
      }

      if (accounts.length < 1000) break; // last page
      if (page === MAX_DAS_PAGES) hitPageLimit = true;
    }

    // Count unique owners holding a non-infra balance.
    let count = 0;
    for (const bal of ownerBalances.values()) {
      if (bal > 0 && bal < INFRA_THRESHOLD) count++;
    }

    return { count, capped: hitPageLimit || count >= HOLDER_COUNT_CAP };
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

    // ── STEP 2: TRUE holder count ────────────────────────────────────────────
    // getTokenLargestAccounts (STEP 1) is capped at 20 results (19 real after infra),
    // making the count useless as a filter. STEP 2 enumerates ALL token accounts for
    // the mint and counts unique owner wallets to get the real number.
    //
    // Primary path: Helius DAS `getTokenAccounts` — indexed, paginated, reliable.
    // Fallback path: getProgramAccounts(TOKEN_PROGRAM_ID) — only if DAS is unavailable
    //   (non-Helius RPC). This is a full-program scan that providers frequently block
    //   or rate-limit, which is exactly why the count used to stay pinned at 19.
    // Only overwrites STEP 1's count if we got a real result (> 0).
    let upgraded = false;
    try {
      const das = await this.getTrueHolderCountViaDAS(mint);
      if (das && das.count > 0) {
        result.holderCount = das.count;
        result.holderCountCapped = das.capped;
        upgraded = true;
        logger.info(
          { mint: mint.slice(0, 8), count: das.count, capped: das.capped },
          'True holder count from DAS getTokenAccounts'
        );
      }
    } catch (err) {
      logger.debug(
        { mint: mint.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
        'DAS getTokenAccounts upgrade failed — trying getProgramAccounts fallback'
      );
    }

    // Fallback: getProgramAccounts (only when DAS didn't produce a count).
    // dataSlice is intentionally omitted — combining it with dataSize can cause some
    // RPC nodes to evaluate dataSize against the sliced (0) length and return 0 results.
    if (!upgraded) {
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
              'True holder count from getProgramAccounts (fallback)'
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
