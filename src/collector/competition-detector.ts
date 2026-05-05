import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import { insertCompetitionSignal, getExistingSignatures, computeBuyPressureAggregates, updateBuyPressureMetrics, computeSniperAggregates, updateSniperMetrics } from '../db/queries';
import { ObservationContext } from './price-collector';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('competition-detector');

// Known program IDs that aren't user wallets
const SYSTEM_PROGRAMS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
]);

export class CompetitionDetector {
  private db: Database.Database;
  private connection: Connection;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  async detectCompetition(ctx: ObservationContext): Promise<void> {
    // Synthetic pool addresses (e.g. "vaults:abc12345") are stored when the pool PDA
    // wasn't extractable from the migration tx. They're valid for vault-based price
    // collection but can't be used as RPC addresses — skip detection in that case.
    try { new PublicKey(ctx.poolAddress); } catch {
      logger.debug({ graduationId: ctx.graduationId, poolAddress: ctx.poolAddress }, 'Skipping competition detection: synthetic pool address');
      return;
    }

    try {
      // Get recent transactions for the pool — drop if queue already backed up
      if (!await globalRpcLimiter.throttleOrDrop(10)) {
        logger.info({ graduationId: ctx.graduationId }, 'Skipping competition detection: RPC queue full');
        return;
      }
      // Retry getSignaturesForAddress up to 3 attempts with backoff. Without
      // try/catch in the loop, a `fetch failed` blip drops the entire
      // competition-detection pass — the row's buy_pressure_* / sniper_*
      // fields stay NULL and research filters depending on them skip the row.
      let signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>> = [];
      let lastErr: string | null = null;
      let succeeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        try {
          signatures = await this.connection.getSignaturesForAddress(
            new PublicKey(ctx.poolAddress),
            { limit: 20 }
          );
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (!succeeded) {
        logger.warn(
          { graduationId: ctx.graduationId, lastErr },
          'Competition detection: getSignaturesForAddress threw on all 3 retries — skipping'
        );
        return;
      }

      if (signatures.length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      let txCount = 0;
      let txFetched = 0;
      const MAX_TX_FETCHES = 10; // cap individual getParsedTransaction calls per detection run

      for (const sigInfo of signatures) {
        // Only look at transactions within the first ~30 seconds
        const txTime = sigInfo.blockTime || now;
        const secSinceGrad = txTime - ctx.graduationTimestamp;

        if (secSinceGrad < 0 || secSinceGrad > 30) continue;

        txCount++;
        if (txFetched >= MAX_TX_FETCHES) continue;
        txFetched++;

        try {
          if (!await globalRpcLimiter.throttleOrDrop(10)) continue;
          const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta || tx.meta.err) continue;

          // Extract the signer (first account key is usually the fee payer)
          const accountKeys = tx.transaction.message.accountKeys;
          const signer = accountKeys[0];
          const signerAddress = typeof signer === 'string'
            ? signer
            : signer.pubkey.toBase58();

          // Determine action from token balance changes
          let action = 'unknown';
          let amountSol: number | undefined;

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

          // Bot heuristics:
          // 1. Transaction within 2 seconds of graduation
          // 2. Uses priority fees (ComputeBudget)
          // 3. Sends exact round amounts
          const isEarly = secSinceGrad <= 2;
          const usesPriorityFee = tx.transaction.message.instructions.some((ix: any) => {
            const progId = 'programId' in ix
              ? (typeof ix.programId === 'string' ? ix.programId : ix.programId.toBase58())
              : '';
            return progId === 'ComputeBudget111111111111111111111111111111';
          });
          const isLikelyBot = (isEarly && usesPriorityFee) ? 1 : 0;

          insertCompetitionSignal(this.db, {
            graduation_id: ctx.graduationId,
            timestamp: txTime,
            seconds_since_graduation: secSinceGrad,
            tx_signature: sigInfo.signature,
            wallet_address: signerAddress,
            action,
            amount_sol: amountSol,
            is_likely_bot: isLikelyBot,
          });
        } catch {
          // Skip individual tx failures
          continue;
        }
      }

      logger.info(
        {
          graduationId: ctx.graduationId,
          mint: ctx.mint,
          pool: ctx.poolAddress,
          txCount,
        },
        'Competition detection complete'
      );
    } catch (err) {
      logger.error(
        'Competition detection failed for grad %d: %s',
        ctx.graduationId,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Buy Pressure Quality detection — runs at T+35 to capture the full 0-30s window.
   *
   * Phase A: Fetch ALL pool signatures in the 0-30s window, parse new ones (up to 50),
   *          and store in competition_signals (skipping those already stored by T+10 run).
   * Phase B: Compute aggregate metrics (unique buyers, buy/sell ratio, whale %, trade count)
   *          from competition_signals via SQL and write to graduation_momentum.
   */
  async detectBuyPressure(ctx: ObservationContext): Promise<void> {
    const MAX_NEW_TX_PARSES = 50;

    // Same guard as detectCompetition — synthetic pool addresses aren't valid RPC addresses.
    try { new PublicKey(ctx.poolAddress); } catch {
      logger.debug({ graduationId: ctx.graduationId, poolAddress: ctx.poolAddress }, 'Skipping buy pressure detection: synthetic pool address');
      return;
    }

    try {
      // Phase A: Fetch signatures and parse new transactions
      if (!await globalRpcLimiter.throttleOrDrop(20)) {
        logger.info({ graduationId: ctx.graduationId }, 'Skipping buy pressure detection: RPC queue full');
        return;
      }

      // Same retry pattern as detectCompetition. A thrown `fetch failed` here
      // would drop the entire buy-pressure pass, leaving sniper_* and
      // buy_pressure_* fields NULL on the grad row. 3 attempts ~3s budget.
      let signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>> = [];
      let lastErr: string | null = null;
      let succeeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        try {
          signatures = await this.connection.getSignaturesForAddress(
            new PublicKey(ctx.poolAddress),
            { limit: 1000 }
          );
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (!succeeded) {
        logger.warn(
          { graduationId: ctx.graduationId, lastErr },
          'Buy pressure detection: getSignaturesForAddress threw on all 3 retries — skipping'
        );
        return;
      }

      if (signatures.length === 0) {
        // No transactions at all — write zeros
        updateBuyPressureMetrics(this.db, ctx.graduationId, {
          unique_buyers: 0,
          buy_ratio: null,
          whale_pct: null,
          trade_count: 0,
        });
        logger.info({ graduationId: ctx.graduationId }, 'Buy pressure: no pool transactions found');
        return;
      }

      // Filter to 0-30s window
      const windowSigs = signatures.filter((sig) => {
        if (!sig.blockTime) return false;
        const elapsed = sig.blockTime - ctx.graduationTimestamp;
        return elapsed >= 0 && elapsed <= 30;
      });

      const totalTradeCount = windowSigs.length;

      // Find which signatures we already stored from the T+10 competition detection run
      const existingSigs = getExistingSignatures(this.db, ctx.graduationId);
      const newSigs = windowSigs.filter((s) => !existingSigs.has(s.signature));

      // Parse new transactions (capped at MAX_NEW_TX_PARSES)
      const toParse = newSigs.slice(0, MAX_NEW_TX_PARSES);
      let parsed = 0;

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

          let action = 'unknown';
          let amountSol: number | undefined;

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

          const txTime = sigInfo.blockTime || Math.floor(Date.now() / 1000);
          const secSinceGrad = txTime - ctx.graduationTimestamp;

          const isEarly = secSinceGrad <= 2;
          const usesPriorityFee = tx.transaction.message.instructions.some((ix: any) => {
            const progId = 'programId' in ix
              ? (typeof ix.programId === 'string' ? ix.programId : ix.programId.toBase58())
              : '';
            return progId === 'ComputeBudget111111111111111111111111111111';
          });
          const isLikelyBot = (isEarly && usesPriorityFee) ? 1 : 0;

          insertCompetitionSignal(this.db, {
            graduation_id: ctx.graduationId,
            timestamp: txTime,
            seconds_since_graduation: secSinceGrad,
            tx_signature: sigInfo.signature,
            wallet_address: signerAddress,
            action,
            amount_sol: amountSol,
            is_likely_bot: isLikelyBot,
          });

          parsed++;
        } catch {
          continue;
        }
      }

      // Phase B: Compute aggregates from all stored signals and write to graduation_momentum
      const aggregates = computeBuyPressureAggregates(this.db, ctx.graduationId);

      // Use signature-based trade count (more accurate than parsed-only SQL count)
      // if we had to cap parsing and thus SQL count is lower than reality
      const finalTradeCount = Math.max(totalTradeCount, aggregates.trade_count);

      updateBuyPressureMetrics(this.db, ctx.graduationId, {
        unique_buyers: aggregates.unique_buyers,
        buy_ratio: aggregates.buy_ratio,
        whale_pct: aggregates.whale_pct,
        trade_count: finalTradeCount,
      });

      // Sniper aggregates from the same competition_signals window. Computed
      // here (T+35) since by now the parser has seen everything in T+0..T+30s.
      const sniperAgg = computeSniperAggregates(this.db, ctx.graduationId);
      updateSniperMetrics(this.db, ctx.graduationId, sniperAgg);

      logger.info(
        {
          graduationId: ctx.graduationId,
          mint: ctx.mint,
          totalSigs: totalTradeCount,
          newParsed: parsed,
          skippedExisting: existingSigs.size,
          uniqueBuyers: aggregates.unique_buyers,
          buyRatio: aggregates.buy_ratio?.toFixed(2) ?? 'N/A',
          whalePct: aggregates.whale_pct?.toFixed(2) ?? 'N/A',
          sniperCount: sniperAgg.count,
          sniperSol: sniperAgg.sol.toFixed(2),
          sniperVelAvg: sniperAgg.velocity_avg?.toFixed(2) ?? 'N/A',
        },
        'Buy pressure detection complete'
      );
    } catch (err) {
      logger.error(
        'Buy pressure detection failed for grad %d: %s',
        ctx.graduationId,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
