import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

/**
 * Shared swap-transaction parser for the copy-trade subsystem.
 *
 * Consolidates the buy/sell classification logic that previously lived in two
 * places — competition-detector.ts (T+0..T+30 sniper window) and swap-logger.ts
 * (T+30..T+300 backfill). Both classified by signer SOL delta + token-balance
 * delta; this generalizes to ANY owner (the copied wallet is rarely the fee
 * payer at accountKeys[0]) and adds best-effort venue attribution.
 *
 * Returns null when the tx isn't a recognizable swap for `owner` (no SOL move,
 * failed tx, owner not present, or only a WSOL leg with no SPL token leg).
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Best-effort venue attribution by program id present in the tx.
const VENUE_PROGRAMS: Record<string, string> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun_bc',   // bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pumpswap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium_amm',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'raydium_clmm',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'jupiter',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora_dlmm',
};

// SOL move below this (in SOL) is treated as fee/noise, not a trade leg.
const MIN_SOL_DELTA = 0.01;

export interface ParsedSwap {
  /** 'buy' = owner spent SOL to acquire the token; 'sell' = owner received SOL. */
  action: 'buy' | 'sell';
  /** The non-WSOL SPL mint that changed hands. */
  mint: string;
  /** Signed SOL change for the owner (negative on buy, positive on sell). */
  solDelta: number;
  /** Signed token change for the owner (positive on buy, negative on sell). */
  tokenDelta: number;
  /** Best-effort venue label, or 'unknown'. */
  venue: string;
}

function programIdsOf(tx: ParsedTransactionWithMeta): Set<string> {
  const ids = new Set<string>();
  const ixs = tx.transaction.message.instructions as Array<{ programId?: PublicKey | string }>;
  for (const ix of ixs) {
    const pid = ix.programId;
    if (!pid) continue;
    ids.add(typeof pid === 'string' ? pid : pid.toBase58());
  }
  // Inner instructions carry the real venue when a router (Jupiter) wraps it.
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions as Array<{ programId?: PublicKey | string }>) {
      const pid = ix.programId;
      if (!pid) continue;
      ids.add(typeof pid === 'string' ? pid : pid.toBase58());
    }
  }
  return ids;
}

function detectVenue(tx: ParsedTransactionWithMeta): string {
  const ids = programIdsOf(tx);
  // Prefer the most specific AMM/bonding-curve over a wrapping router.
  for (const [prog, venue] of Object.entries(VENUE_PROGRAMS)) {
    if (venue !== 'jupiter' && ids.has(prog)) return venue;
  }
  if (ids.has('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')) return 'jupiter';
  return 'unknown';
}

/**
 * Parse a swap from `owner`'s perspective. `owner` is a base58 wallet address.
 */
export function parseSwapForOwner(
  tx: ParsedTransactionWithMeta,
  owner: string,
): ParsedSwap | null {
  if (!tx.meta || tx.meta.err) return null;
  const { preBalances, postBalances, preTokenBalances, postTokenBalances } = tx.meta;
  if (!preBalances || !postBalances) return null;

  // Locate the owner's account index for the native-SOL delta.
  const accountKeys = tx.transaction.message.accountKeys;
  const ownerIdx = accountKeys.findIndex((k) => {
    const addr = typeof (k as { pubkey?: PublicKey }).pubkey !== 'undefined'
      ? (k as { pubkey: PublicKey }).pubkey.toBase58()
      : String(k);
    return addr === owner;
  });
  if (ownerIdx < 0) return null;

  const solDelta = (postBalances[ownerIdx] - preBalances[ownerIdx]) / 1_000_000_000;
  if (Math.abs(solDelta) < MIN_SOL_DELTA) return null;

  // Token delta for the owner across all non-WSOL mints. The swapped token is
  // the one whose owner-held balance changed the most in absolute terms.
  const pre = (preTokenBalances ?? []).filter((b) => b.owner === owner && b.mint !== WSOL_MINT);
  const post = (postTokenBalances ?? []).filter((b) => b.owner === owner && b.mint !== WSOL_MINT);
  const mints = new Set<string>([...pre.map((b) => b.mint), ...post.map((b) => b.mint)]);

  let bestMint: string | null = null;
  let bestDelta = 0;
  for (const mint of mints) {
    const preAmt = pre.find((b) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt = post.find((b) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
    const delta = postAmt - preAmt;
    if (Math.abs(delta) > Math.abs(bestDelta)) {
      bestDelta = delta;
      bestMint = mint;
    }
  }
  if (bestMint === null || bestDelta === 0) return null;

  // Direction must agree: a buy spends SOL (solDelta<0) and gains token
  // (tokenDelta>0); a sell is the reverse. Reject ambiguous legs (e.g. an LP
  // add) where the signs don't line up.
  const action: 'buy' | 'sell' = solDelta < 0 ? 'buy' : 'sell';
  if (action === 'buy' && bestDelta < 0) return null;
  if (action === 'sell' && bestDelta > 0) return null;

  return {
    action,
    mint: bestMint,
    solDelta,
    tokenDelta: bestDelta,
    venue: detectVenue(tx),
  };
}
