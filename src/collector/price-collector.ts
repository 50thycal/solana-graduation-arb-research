import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import {
  insertPoolObservation,
  insertPriceComparison,
  markObservationComplete,
} from '../db/queries';
import { OpportunityScorer } from '../analysis/opportunity-scorer';
import { CompetitionDetector } from './competition-detector';

const logger = pino({ name: 'price-collector' });

// Snapshot schedule: seconds after graduation
const SNAPSHOT_SCHEDULE = [0, 1, 2, 5, 10, 30, 60, 120, 300];

const LAMPORTS_PER_SOL = new BN(1_000_000_000);
const TOKEN_DECIMAL_FACTOR = new BN(10 ** 6);

// PumpSwap pool account layout (AMM pool)
// Standard constant-product pool: token_a_reserves, token_b_reserves
// Layout varies by DEX — we read the token accounts directly
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ObservationContext {
  graduationId: number;
  mint: string;
  poolAddress: string;
  poolDex: string;
  bondingCurvePrice: number;
  graduationTimestamp: number;
  migrationTimestamp: number;
}

interface ActiveObservation {
  ctx: ObservationContext;
  startedAt: number;
  scheduledSnapshots: number[];
  completedSnapshots: number[];
  timers: NodeJS.Timeout[];
}

export class PriceCollector {
  private db: Database.Database;
  private connection: Connection;
  private active: Map<number, ActiveObservation> = new Map();
  private opportunityScorer: OpportunityScorer;
  private competitionDetector: CompetitionDetector;
  private totalObservationsStarted = 0;
  private totalObservationsCompleted = 0;
  private totalSnapshots = 0;

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
    this.opportunityScorer = new OpportunityScorer(db);
    this.competitionDetector = new CompetitionDetector(db, connection);
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
    this.competitionDetector.updateConnection(connection);
  }

  getStats() {
    return {
      activeObservations: this.active.size,
      totalStarted: this.totalObservationsStarted,
      totalCompleted: this.totalObservationsCompleted,
      totalSnapshots: this.totalSnapshots,
    };
  }

  startObservation(ctx: ObservationContext): void {
    if (this.active.has(ctx.graduationId)) {
      logger.debug({ graduationId: ctx.graduationId }, 'Observation already active');
      return;
    }

    const maxActive = parseInt(process.env.MAX_CONCURRENT_OBSERVATIONS || '20', 10);
    if (this.active.size >= maxActive) {
      logger.debug({ graduationId: ctx.graduationId, active: this.active.size }, 'Max active observations');
      return;
    }

    this.totalObservationsStarted++;

    const now = Date.now();
    const migrationTime = ctx.migrationTimestamp * 1000;
    const elapsedSec = (now - migrationTime) / 1000;

    // Filter out snapshots that are already in the past
    const remaining = SNAPSHOT_SCHEDULE.filter((s) => s > elapsedSec - 1);

    const observation: ActiveObservation = {
      ctx,
      startedAt: now,
      scheduledSnapshots: remaining,
      completedSnapshots: [],
      timers: [],
    };

    this.active.set(ctx.graduationId, observation);

    logger.info(
      {
        graduationId: ctx.graduationId,
        mint: ctx.mint,
        pool: ctx.poolAddress,
        bondingCurvePrice: ctx.bondingCurvePrice,
        elapsedSec: Math.round(elapsedSec),
        snapshotsRemaining: remaining.length,
      },
      'Starting price observation'
    );

    // Take an immediate snapshot
    this.takeSnapshot(ctx.graduationId, elapsedSec);

    // Schedule remaining snapshots
    for (const targetSec of remaining) {
      const delayMs = (targetSec - elapsedSec) * 1000;
      if (delayMs <= 0) continue;

      const timer = setTimeout(() => {
        this.takeSnapshot(ctx.graduationId, targetSec);
      }, delayMs);

      observation.timers.push(timer);
    }

    // Schedule competition detection at T+10s
    const competitionDelay = (10 - elapsedSec) * 1000;
    if (competitionDelay > 0) {
      const timer = setTimeout(() => {
        this.competitionDetector.detectCompetition(ctx).catch((err) => {
          logger.error(
            'Competition detection failed for grad %d: %s',
            ctx.graduationId,
            err instanceof Error ? err.message : String(err)
          );
        });
      }, competitionDelay);
      observation.timers.push(timer);
    } else {
      // Already past 10s, run immediately
      this.competitionDetector.detectCompetition(ctx).catch(() => {});
    }

    // Schedule observation completion
    const maxSnapshotSec = SNAPSHOT_SCHEDULE[SNAPSHOT_SCHEDULE.length - 1];
    const completionDelay = (maxSnapshotSec - elapsedSec + 5) * 1000; // 5s buffer
    const completionTimer = setTimeout(() => {
      this.completeObservation(ctx.graduationId);
    }, Math.max(completionDelay, 5000));

    observation.timers.push(completionTimer);
  }

  stop(): void {
    for (const [, obs] of this.active) {
      for (const timer of obs.timers) {
        clearTimeout(timer);
      }
    }
    this.active.clear();
  }

  private async takeSnapshot(graduationId: number, targetSec: number): Promise<void> {
    const observation = this.active.get(graduationId);
    if (!observation) return;

    const ctx = observation.ctx;
    const now = Math.floor(Date.now() / 1000);
    const actualSecSinceGraduation = now - ctx.graduationTimestamp;

    try {
      // Fetch pool state to get current price
      const poolState = await this.fetchPoolPrice(ctx.poolAddress, ctx.mint);

      if (!poolState) {
        logger.debug(
          { graduationId, targetSec, pool: ctx.poolAddress },
          'Could not fetch pool state for snapshot'
        );
        return;
      }

      this.totalSnapshots++;
      observation.completedSnapshots.push(targetSec);

      // Insert pool observation
      insertPoolObservation(this.db, {
        graduation_id: graduationId,
        timestamp: now,
        seconds_since_graduation: actualSecSinceGraduation,
        pool_price_sol: poolState.price,
        pool_sol_reserves: poolState.solReserves,
        pool_token_reserves: poolState.tokenReserves,
        pool_liquidity_usd: undefined, // Would need SOL/USD price
      });

      // Calculate spread and insert price comparison
      const bcPrice = ctx.bondingCurvePrice;
      const dexPrice = poolState.price;

      let bcToDexSpread: number | undefined;
      if (bcPrice > 0 && dexPrice > 0) {
        bcToDexSpread = ((dexPrice - bcPrice) / bcPrice) * 100;
      }

      insertPriceComparison(this.db, {
        graduation_id: graduationId,
        timestamp: now,
        seconds_since_graduation: actualSecSinceGraduation,
        bonding_curve_price: bcPrice,
        dex_pool_price: dexPrice,
        bc_to_dex_spread_pct: bcToDexSpread,
      });

      // Log notable spreads
      if (bcToDexSpread !== undefined && Math.abs(bcToDexSpread) > 1) {
        logger.info(
          {
            graduationId,
            mint: ctx.mint,
            secondsSinceGrad: actualSecSinceGraduation,
            bcPrice: bcPrice.toFixed(12),
            dexPrice: dexPrice.toFixed(12),
            spreadPct: bcToDexSpread.toFixed(2),
          },
          'Notable price spread detected'
        );
      }
    } catch (err) {
      logger.error(
        'Snapshot failed for grad %d at T+%ds: %s',
        graduationId,
        targetSec,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async fetchPoolPrice(
    poolAddress: string,
    mint: string
  ): Promise<{ price: number; solReserves: number; tokenReserves: number } | null> {
    try {
      // For PumpSwap/Raydium pools, we need to read the pool's token accounts
      // The pool account itself holds references to token vaults
      // Approach: fetch the pool account and decode its token vault balances

      const poolPubkey = new PublicKey(poolAddress);
      const poolInfo = await this.connection.getAccountInfo(poolPubkey);

      if (!poolInfo || !poolInfo.data) return null;

      // Try to decode the pool's reserves from account data
      // PumpSwap pools store reserves in the account data
      const reserves = this.decodePoolReserves(poolInfo, mint);
      if (reserves) return reserves;

      // Fallback: find the pool's token accounts and read their balances
      return await this.fetchPoolReservesFromTokenAccounts(poolAddress, mint);
    } catch (err) {
      logger.debug(
        'Failed to fetch pool price for %s: %s',
        poolAddress.slice(0, 8),
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  private decodePoolReserves(
    poolInfo: AccountInfo<Buffer>,
    mint: string
  ): { price: number; solReserves: number; tokenReserves: number } | null {
    const data = poolInfo.data;

    // PumpSwap pool layout (estimated based on common AMM patterns):
    // Various headers/discriminators, then two u64 reserve fields
    // Try several common offsets for reserve data

    if (data.length < 200) return null;

    // Try common AMM layouts — two consecutive u64 values representing reserves
    // We try multiple offsets because different pool versions may differ
    const offsets = [72, 80, 88, 96, 104, 112, 128, 136, 144, 152, 160, 168];

    for (let i = 0; i < offsets.length - 1; i++) {
      const offset1 = offsets[i];
      const offset2 = offset1 + 8;

      if (offset2 + 8 > data.length) continue;

      const val1 = new BN(data.subarray(offset1, offset1 + 8), 'le');
      const val2 = new BN(data.subarray(offset2, offset2 + 8), 'le');

      // Sanity check: both values should be reasonable
      // SOL reserves: typically 10-200 SOL (10e9 to 200e9 lamports)
      // Token reserves: typically > 0 and < total supply
      const v1Num = val1.toNumber();
      const v2Num = val2.toNumber();

      const MIN_SOL_LAMPORTS = 1_000_000_000; // 1 SOL
      const MAX_SOL_LAMPORTS = 500_000_000_000; // 500 SOL

      // Check if val1 looks like SOL and val2 looks like tokens
      if (v1Num >= MIN_SOL_LAMPORTS && v1Num <= MAX_SOL_LAMPORTS && v2Num > 0) {
        const solReserves = bnToNumber(val1, LAMPORTS_PER_SOL);
        const tokenReserves = bnToNumber(val2, TOKEN_DECIMAL_FACTOR);
        if (tokenReserves > 0) {
          return {
            price: solReserves / tokenReserves,
            solReserves,
            tokenReserves,
          };
        }
      }

      // Check reverse: val1 = tokens, val2 = SOL
      if (v2Num >= MIN_SOL_LAMPORTS && v2Num <= MAX_SOL_LAMPORTS && v1Num > 0) {
        const solReserves = bnToNumber(val2, LAMPORTS_PER_SOL);
        const tokenReserves = bnToNumber(val1, TOKEN_DECIMAL_FACTOR);
        if (tokenReserves > 0) {
          return {
            price: solReserves / tokenReserves,
            solReserves,
            tokenReserves,
          };
        }
      }
    }

    return null;
  }

  private async fetchPoolReservesFromTokenAccounts(
    poolAddress: string,
    mint: string
  ): Promise<{ price: number; solReserves: number; tokenReserves: number } | null> {
    try {
      // Get token accounts owned by the pool
      const poolPubkey = new PublicKey(poolAddress);

      // Fetch SOL balance of the pool
      const solBalance = await this.connection.getBalance(poolPubkey);

      // Fetch token accounts for this mint owned by the pool
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(poolPubkey, {
        mint: new PublicKey(mint),
      });

      if (tokenAccounts.value.length === 0) return null;

      // Parse token balance from the first token account
      const tokenAccountData = tokenAccounts.value[0].account.data;
      // SPL token account layout: mint (32) + owner (32) + amount (u64 at offset 64)
      if (tokenAccountData.length < 72) return null;

      const tokenAmount = new BN(tokenAccountData.subarray(64, 72), 'le');

      const solReserves = solBalance / 1_000_000_000;
      const tokenReserves = bnToNumber(tokenAmount, TOKEN_DECIMAL_FACTOR);

      if (solReserves <= 0 || tokenReserves <= 0) return null;

      return {
        price: solReserves / tokenReserves,
        solReserves,
        tokenReserves,
      };
    } catch {
      return null;
    }
  }

  private completeObservation(graduationId: number): void {
    const observation = this.active.get(graduationId);
    if (!observation) return;

    // Clear remaining timers
    for (const timer of observation.timers) {
      clearTimeout(timer);
    }

    this.active.delete(graduationId);
    this.totalObservationsCompleted++;

    // Mark observation complete in DB
    markObservationComplete(this.db, graduationId);

    // Score the opportunity
    try {
      this.opportunityScorer.scoreOpportunity(graduationId);
    } catch (err) {
      logger.error(
        'Opportunity scoring failed for grad %d: %s',
        graduationId,
        err instanceof Error ? err.message : String(err)
      );
    }

    logger.info(
      {
        graduationId,
        mint: observation.ctx.mint,
        completedSnapshots: observation.completedSnapshots.length,
        totalCompleted: this.totalObservationsCompleted,
      },
      'Observation complete'
    );
  }
}

function bnToNumber(value: BN, divisor: BN): number {
  const whole = value.div(divisor);
  const remainder = value.mod(divisor);
  return whole.toNumber() + remainder.toNumber() / divisor.toNumber();
}
