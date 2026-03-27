import { Connection, PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { insertCompetitionSignal } from '../db/queries';
import { ObservationContext } from './price-collector';
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = pino({ name: 'competition-detector' });

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
    try {
      // Get recent transactions for the pool — drop if queue already backed up
      if (!await globalRpcLimiter.throttleOrDrop(10)) {
        logger.info({ graduationId: ctx.graduationId }, 'Skipping competition detection: RPC queue full');
        return;
      }
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(ctx.poolAddress),
        { limit: 20 }
      );

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
}
