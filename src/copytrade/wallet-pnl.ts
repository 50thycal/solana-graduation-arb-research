import { Connection, PublicKey } from '@solana/web3.js';
import { SIM_DEFAULT_COST_PCT } from '../api/sim-constants';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { parseSwapForOwner } from './parse-swap';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('wallet-pnl');

/**
 * Wallet P&L engine (copy-trade Option B, Phase 1).
 *
 * Reconstructs a wallet's realized SOL P&L from its on-chain swap stream via
 * FIFO lot-matching, then scores it under the SAME bar the strategy book uses
 * (n>=100 · drop_top3>0 · monthly>=3.75) so the ranker can treat a wallet like
 * a strategy. Pure functions (reconstructRoundTrips / scoreWallet) are RPC-free
 * and unit-testable; fetchWalletSwaps does the on-chain I/O.
 *
 * Cost realism: every round trip is haircut by SIM_DEFAULT_COST_PCT (the same
 * 3% round-trip cost the in-memory simulators charge) applied to the entry
 * notional — we rank wallets by what WE would net copying them, not by their
 * own (lower-cost, faster-fill) realized P&L.
 */

export interface WalletSwap {
  signature: string;
  blockTime: number;
  mint: string;
  action: 'buy' | 'sell';
  solDelta: number;   // signed: negative on buy, positive on sell
  tokenDelta: number; // signed: positive on buy, negative on sell
  venue: string;
}

export interface RoundTrip {
  mint: string;
  openTs: number;
  closeTs: number;
  solIn: number;      // SOL cost of the matched lot (positive)
  solOut: number;     // SOL proceeds of the matched portion (positive)
  realizedSol: number; // solOut - solIn - copy cost
  holdSec: number;
}

export interface WalletScore {
  address: string;
  nRoundTrips: number;
  totalRealizedSol: number;
  totalRealizedSolDropTop3: number;
  medianRtPct: number | null;
  monthlyRunRateSol: number | null;
  winRate: number | null;
  avgHoldSec: number | null;
  lastActive: number | null;
  venues: Record<string, number>;
}

interface OpenLot {
  tokensRemaining: number;
  solInRemaining: number;
  openTs: number;
}

/**
 * FIFO-match a wallet's chronologically-ordered swaps into realized round
 * trips. Sells with no matching prior buy (tokens acquired outside our
 * visibility — airdrops, transfers, pre-history) are skipped, not attributed a
 * zero cost. Unclosed buy lots at the end are unrealized and excluded.
 */
export function reconstructRoundTrips(
  swaps: WalletSwap[],
  costPct: number = SIM_DEFAULT_COST_PCT,
): RoundTrip[] {
  const sorted = [...swaps].sort((a, b) => a.blockTime - b.blockTime);
  const lotsByMint = new Map<string, OpenLot[]>();
  const roundTrips: RoundTrip[] = [];
  const EPS = 1e-9;

  for (const s of sorted) {
    if (!lotsByMint.has(s.mint)) lotsByMint.set(s.mint, []);
    const lots = lotsByMint.get(s.mint)!;

    if (s.action === 'buy') {
      const tokens = Math.abs(s.tokenDelta);
      const solIn = Math.abs(s.solDelta);
      if (tokens > EPS && solIn > EPS) {
        lots.push({ tokensRemaining: tokens, solInRemaining: solIn, openTs: s.blockTime });
      }
      continue;
    }

    // sell — match FIFO against open lots
    let sellTokens = Math.abs(s.tokenDelta);
    const solOutTotal = Math.abs(s.solDelta);
    if (sellTokens <= EPS) continue;
    const proceedsPerToken = solOutTotal / sellTokens;

    while (sellTokens > EPS && lots.length > 0) {
      const lot = lots[0];
      const matched = Math.min(lot.tokensRemaining, sellTokens);
      const fraction = matched / lot.tokensRemaining;
      const solInPortion = lot.solInRemaining * fraction;
      const solOutPortion = matched * proceedsPerToken;
      const copyCost = (solInPortion * costPct) / 100;
      roundTrips.push({
        mint: s.mint,
        openTs: lot.openTs,
        closeTs: s.blockTime,
        solIn: solInPortion,
        solOut: solOutPortion,
        realizedSol: solOutPortion - solInPortion - copyCost,
        holdSec: Math.max(0, s.blockTime - lot.openTs),
      });
      lot.tokensRemaining -= matched;
      lot.solInRemaining -= solInPortion;
      sellTokens -= matched;
      if (lot.tokensRemaining <= EPS) lots.shift();
    }
    // sellTokens left over => tokens with no visible buy; drop (no cost basis).
  }

  return roundTrips;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Aggregate reconstructed round trips into the strategy-comparable score. */
export function scoreWallet(
  address: string,
  swaps: WalletSwap[],
  costPct: number = SIM_DEFAULT_COST_PCT,
): WalletScore {
  const rts = reconstructRoundTrips(swaps, costPct);
  const n = rts.length;

  const realized = rts.map((r) => r.realizedSol);
  const total = realized.reduce((a, b) => a + b, 0);

  // drop_top3 — outlier robustness (CLAUDE.md item 2). Sum minus the 3 best.
  const top3 = [...realized].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const dropTop3 = total - top3;

  const rtPcts = rts.filter((r) => r.solIn > 0).map((r) => (r.realizedSol / r.solIn) * 100);
  const wins = realized.filter((r) => r > 0).length;
  const holds = rts.map((r) => r.holdSec);

  // monthly run rate — total realized normalized over the active span.
  let monthly: number | null = null;
  let lastActive: number | null = null;
  if (n > 0) {
    const firstOpen = Math.min(...rts.map((r) => r.openTs));
    const lastClose = Math.max(...rts.map((r) => r.closeTs));
    lastActive = lastClose;
    const spanDays = (lastClose - firstOpen) / 86_400;
    if (spanDays > 0.5) monthly = (total / spanDays) * 30;
  }

  const venues: Record<string, number> = {};
  for (const s of swaps) venues[s.venue] = (venues[s.venue] ?? 0) + 1;

  return {
    address,
    nRoundTrips: n,
    totalRealizedSol: total,
    totalRealizedSolDropTop3: dropTop3,
    medianRtPct: median(rtPcts),
    monthlyRunRateSol: monthly,
    winRate: n > 0 ? wins / n : null,
    avgHoldSec: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    lastActive,
    venues,
  };
}

/**
 * Fetch and parse a wallet's recent swap history from chain.
 *
 * Paginates getSignaturesForAddress back to `maxSignatures`, then parses each tx
 * from `owner`'s perspective. RPC-budget guarded by globalRpcLimiter — this is
 * the heavy path, so callers should cap candidate counts. Returns chronological
 * (oldest-first) WalletSwap rows; non-swap txs are silently dropped.
 */
export async function fetchWalletSwaps(
  connection: Connection,
  address: string,
  opts: { maxSignatures?: number; maxParse?: number } = {},
): Promise<WalletSwap[]> {
  const maxSignatures = opts.maxSignatures ?? 1000;
  const maxParse = opts.maxParse ?? maxSignatures;
  let owner: PublicKey;
  try {
    owner = new PublicKey(address);
  } catch {
    return [];
  }

  // Page back through signature history.
  const sigInfos: Array<{ signature: string; blockTime?: number | null }> = [];
  let before: string | undefined;
  while (sigInfos.length < maxSignatures) {
    if (!(await globalRpcLimiter.throttleOrDrop(30))) break;
    let page;
    try {
      page = await connection.getSignaturesForAddress(owner, { limit: 1000, before });
    } catch (err) {
      logger.warn('getSignaturesForAddress failed for %s: %s', address.slice(0, 8),
        err instanceof Error ? err.message : String(err));
      break;
    }
    if (page.length === 0) break;
    for (const p of page) sigInfos.push({ signature: p.signature, blockTime: p.blockTime });
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }

  const swaps: WalletSwap[] = [];
  let parsed = 0;
  for (const info of sigInfos) {
    if (parsed >= maxParse) break;
    if (!(await globalRpcLimiter.throttleOrDrop(20))) continue;
    let tx;
    try {
      tx = await connection.getParsedTransaction(info.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      continue;
    }
    parsed++;
    if (!tx) continue;
    const swap = parseSwapForOwner(tx, address);
    if (!swap) continue;
    swaps.push({
      signature: info.signature,
      blockTime: info.blockTime ?? tx.blockTime ?? 0,
      mint: swap.mint,
      action: swap.action,
      solDelta: swap.solDelta,
      tokenDelta: swap.tokenDelta,
      venue: swap.venue,
    });
  }

  swaps.sort((a, b) => a.blockTime - b.blockTime);
  logger.info('Fetched %d swaps for %s (%d sigs, %d parsed)',
    swaps.length, address.slice(0, 8), sigInfos.length, parsed);
  return swaps;
}
