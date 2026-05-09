import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import { insertPostGradSwap, getPostGradSwapsCount } from '../db/queries';
import { ObservationContext } from './price-collector';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('swap-logger');

// Swap backfill is disabled — the whale_liq exit strategy showed negative EV
// and the 200 getParsedTransaction calls per graduation were saturating the RPC
// queue. Re-enable by setting SWAP_BACKFILL_ENABLED=true in env vars.
// When re-enabled, limit is 50 (was 200) to keep RPC cost manageable.
const SWAP_BACKFILL_ENABLED = process.env.SWAP_BACKFILL_ENABLED === 'true';
const MAX_TX_PARSES = 50;

// Fetch up to this many signatures per call to getSignaturesForAddress.
// 1000 is the RPC cap; for a 270s window (30-300s) this is enough unless the
// pool does >3 swaps/sec, in which case we lose the tail — acceptable for
// research data collection.
const SIG_FETCH_LIMIT = 1000;

export class SwapLogger {
  private db: Database.Database;
  private connection: Connection;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Backfill per-swap rows for the T+30..T+300 window for a completed graduation.
   *
   * Called from PriceCollector.completeObservation() once the 300s observation
   * closes. Mirrors the pattern from CompetitionDetector.detectBuyPressure():
   *   1. getSignaturesForAddress(poolAddress, limit=1000)
   *   2. filter to blockTime in [ctx.graduationTimestamp + 30, +300]
   *   3. parse each tx, classify buy/sell from preBalances/postBalances[0] SOL delta
   *   4. extract token amount where derivable from pre/post token balances
   *   5. insert into post_grad_swaps (ON CONFLICT DO NOTHING)
   *
   * Fire-and-forget from the caller — failures are logged but never thrown.
   */
  async backfillSwaps(ctx: ObservationContext): Promise<void> {
    if (!SWAP_BACKFILL_ENABLED) return;

    try { new PublicKey(ctx.poolAddress); } catch {
      logger.debug(
        { graduationId: ctx.graduationId, poolAddress: ctx.poolAddress },
        'Skipping swap backfill: synthetic pool address',
      );
      return;
    }

    // Skip if we already have rows (idempotency — e.g. on bot restart after crash).
    const existingCount = getPostGradSwapsCount(this.db, ctx.graduationId);
    if (existingCount > 0) {
      logger.debug(
        { graduationId: ctx.graduationId, existingCount },
        'Swap backfill already populated, skipping',
      );
      return;
    }

    try {
      if (!await globalRpcLimiter.throttleOrDrop(30)) {
        logger.info({ graduationId: ctx.graduationId }, 'Skipping swap backfill: RPC queue full');
        return;
      }

      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(ctx.poolAddress),
        { limit: SIG_FETCH_LIMIT },
      );

      if (signatures.length === 0) {
        logger.info({ graduationId: ctx.graduationId }, 'Swap backfill: no pool signatures');
        return;
      }

      const windowSigs = signatures.filter((sig) => {
        if (!sig.blockTime) return false;
        const elapsed = sig.blockTime - ctx.graduationTimestamp;
        return elapsed >= 30 && elapsed <= 300;
      });

      const toParse = windowSigs.slice(0, MAX_TX_PARSES);
      let parsed = 0;
      let buys = 0;
      let sells = 0;

      for (const sigInfo of toParse) {
        try {
          if (!await globalRpcLimiter.throttleOrDrop(20)) continue;

          const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta || tx.meta.err) continue;

          const accountKeys = tx.transaction.message.accountKeys;
          const signer = accountKeys[0];
          const signerAddress = typeof signer === 'string'
            ? signer
            : signer.pubkey.toBase58();

          let action: 'buy' | 'sell' | 'unknown' = 'unknown';
          let amountSol: number | null = null;
          let amountToken: number | null = null;

          // Signer SOL delta (excludes fee because fee is always < trade size in post-grad swaps).
          if (tx.meta.preBalances && tx.meta.postBalances) {
            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1_000_000_000;
            if (solChange < -0.01) {
              action = 'buy';
              amountSol = Math.abs(solChange);
            } else if (solChange > 0.01) {
              action = 'sell';
              amountSol = solChange;
            }
          }

          // Token amount: find the signer's token-balance row for the graduated mint.
          // preTokenBalances / postTokenBalances may each include the signer's ATA;
          // the delta is the tokens bought (buy) or sold (sell).
          if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
            const preRow = tx.meta.preTokenBalances.find(
              (b) => b.mint === ctx.mint && b.owner === signerAddress,
            );
            const postRow = tx.meta.postTokenBalances.find(
              (b) => b.mint === ctx.mint && b.owner === signerAddress,
            );
            const preAmt = preRow?.uiTokenAmount?.uiAmount ?? 0;
            const postAmt = postRow?.uiTokenAmount?.uiAmount ?? 0;
            const delta = postAmt - preAmt;
            if (Math.abs(delta) > 0) {
              amountToken = Math.abs(delta);
            }
          }

          const txTime = sigInfo.blockTime || Math.floor(Date.now() / 1000);
          const secSinceGrad = txTime - ctx.graduationTimestamp;

          insertPostGradSwap(this.db, {
            graduation_id: ctx.graduationId,
            tx_signature: sigInfo.signature,
            block_time: txTime,
            seconds_since_graduation: secSinceGrad,
            wallet_address: signerAddress,
            action,
            amount_sol: amountSol,
            amount_token: amountToken,
            pool_sol_after: null,
          });

          parsed++;
          if (action === 'buy') buys++;
          else if (action === 'sell') sells++;
        } catch {
          continue;
        }
      }

      logger.info(
        {
          graduationId: ctx.graduationId,
          mint: ctx.mint,
          totalSigs: signatures.length,
          windowSigs: windowSigs.length,
          parsed,
          buys,
          sells,
          capped: windowSigs.length > MAX_TX_PARSES,
        },
        'Post-grad swap backfill complete',
      );
    } catch (err) {
      logger.error(
        'Post-grad swap backfill failed for grad %d: %s',
        ctx.graduationId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
