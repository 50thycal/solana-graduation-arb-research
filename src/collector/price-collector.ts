import { Connection, PublicKey } from '@solana/web3.js';
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
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = pino({ name: 'price-collector' });

// Snapshot schedule: seconds after graduation
// Removed T+1 and T+2 — they create RPC bursts with minimal research value
const SNAPSHOT_SCHEDULE = [0, 5, 10, 30, 60, 120, 300];

const LAMPORTS_PER_SOL = new BN(1_000_000_000);
const TOKEN_DECIMAL_FACTOR = new BN(10 ** 6);



export interface ObservationContext {
  graduationId: number;
  mint: string;
  poolAddress: string;
  poolDex: string;
  bondingCurvePrice: number;
  graduationTimestamp: number;
  migrationTimestamp: number;
  // Vault addresses extracted from the pool creation tx — skips pool account decode
  baseVault?: string;
  quoteVault?: string;
}

interface ActiveObservation {
  ctx: ObservationContext;
  startedAt: number;
  scheduledSnapshots: number[];
  completedSnapshots: number[];
  timers: NodeJS.Timeout[];
  // Cached after first successful pool decode — avoids re-fetching pool account on every snapshot
  baseVault?: string;
  quoteVault?: string;
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

    // MAX_CONCURRENT_OBSERVATIONS limits active price observation sessions.
    // Each active session fires RPC calls on a schedule (T+0, T+5, T+10, T+30, T+60, T+120, T+300).
    // At 8 RPS budget, 20 concurrent = ~0.5 RPS from snapshots alone — well within limits.
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
      const poolState = await this.fetchPoolPrice(observation);

      if (!poolState) {
        logger.warn(
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

  // PumpSwap pool account layout (Anchor IDL):
  // [8]  discriminator
  // [1]  pool_bump
  // [2]  index (u16 LE)
  // [32] creator
  // [32] base_mint       (graduated token)
  // [32] quote_mint      (wSOL: So11111111111111111111111111111111111111112)
  // [32] lp_mint
  // [32] pool_base_token_account  ← base vault (token)
  // [32] pool_quote_token_account ← quote vault (wSOL)
  private static readonly POOL_BASE_VAULT_OFFSET = 8 + 1 + 2 + 32 + 32 + 32 + 32; // 139
  private static readonly POOL_QUOTE_VAULT_OFFSET = PriceCollector.POOL_BASE_VAULT_OFFSET + 32; // 171

  private async fetchPoolPrice(
    observation: ActiveObservation
  ): Promise<{ price: number; solReserves: number; tokenReserves: number } | null> {
    const ctx = observation.ctx;
    try {
      // Resolve vault addresses from the pool account (confirmed correct per IDL:
      // pool_base_token_account at offset 139, pool_quote_token_account at offset 171).
      // Cached after first successful fetch so subsequent snapshots skip this RPC call.
      if (!observation.baseVault || !observation.quoteVault) {
        if (!await globalRpcLimiter.throttleOrDrop(15)) {
          logger.warn({ graduationId: ctx.graduationId }, 'Pool account fetch dropped — RPC queue full');
          return null;
        }
        // Retry once after 400ms — pool account may not yet be available at T+0
        let poolInfo = await this.connection.getAccountInfo(new PublicKey(ctx.poolAddress), 'confirmed');
        if (!poolInfo?.data) {
          await new Promise(r => setTimeout(r, 400));
          poolInfo = await this.connection.getAccountInfo(new PublicKey(ctx.poolAddress), 'confirmed');
        }
        if (!poolInfo?.data) {
          logger.warn({ graduationId: ctx.graduationId, pool: ctx.poolAddress }, 'Pool account not found');
          return null;
        }
        const vaults = this.parseVaultAddresses(poolInfo.data as Buffer);
        if (!vaults) {
          logger.warn(
            { graduationId: ctx.graduationId, pool: ctx.poolAddress, dataLen: (poolInfo.data as Buffer).length },
            'Could not parse vault addresses from pool account'
          );
          return null;
        }
        observation.baseVault = vaults.baseVault;
        observation.quoteVault = vaults.quoteVault;
        logger.info(
          { graduationId: ctx.graduationId, baseVault: vaults.baseVault, quoteVault: vaults.quoteVault },
          'Pool vault addresses decoded from pool account'
        );
      }

      // Fetch both vault balances in a single RPC call
      if (!await globalRpcLimiter.throttleOrDrop(15)) {
        logger.warn({ graduationId: ctx.graduationId, targetVault: observation.baseVault?.slice(0, 8) }, 'Snapshot dropped — RPC queue full');
        return null;
      }
      const vaultAccounts = await this.connection.getMultipleAccountsInfo([
        new PublicKey(observation.baseVault),
        new PublicKey(observation.quoteVault),
      ]);

      if (!vaultAccounts[0]?.data || !vaultAccounts[1]?.data) {
        logger.warn(
          { graduationId: ctx.graduationId, baseVault: observation.baseVault?.slice(0, 8), quoteVault: observation.quoteVault?.slice(0, 8), hasBase: !!vaultAccounts[0]?.data, hasQuote: !!vaultAccounts[1]?.data },
          'Vault account data missing'
        );
        return null;
      }

      const baseAmount = this.readTokenAccountAmount(vaultAccounts[0].data as Buffer);
      const quoteAmount = this.readTokenAccountAmount(vaultAccounts[1].data as Buffer);

      if (baseAmount === null || quoteAmount === null || baseAmount === 0 || quoteAmount === 0) {
        logger.warn(
          {
            graduationId: ctx.graduationId,
            baseAmount, quoteAmount,
            baseDataLen: (vaultAccounts[0]!.data as Buffer).length,
            quoteDataLen: (vaultAccounts[1]!.data as Buffer).length,
            baseVault: observation.baseVault,
            quoteVault: observation.quoteVault,
          },
          'Vault amounts zero or unreadable'
        );
        return null;
      }

      // base = graduated token (6 decimals), quote = wSOL (9 decimals)
      const tokenReserves = baseAmount / 1_000_000;
      const solReserves = quoteAmount / 1_000_000_000;

      if (tokenReserves <= 0 || solReserves <= 0) return null;

      return { price: solReserves / tokenReserves, solReserves, tokenReserves };
    } catch (err) {
      logger.debug(
        'Failed to fetch pool price for %s: %s',
        ctx.poolAddress.slice(0, 8),
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  private parseVaultAddresses(data: Buffer): { baseVault: string; quoteVault: string } | null {
    if (data.length < PriceCollector.POOL_QUOTE_VAULT_OFFSET + 32) return null;
    try {
      const baseVaultKey = new PublicKey(data.subarray(PriceCollector.POOL_BASE_VAULT_OFFSET, PriceCollector.POOL_BASE_VAULT_OFFSET + 32));
      const quoteVaultKey = new PublicKey(data.subarray(PriceCollector.POOL_QUOTE_VAULT_OFFSET, PriceCollector.POOL_QUOTE_VAULT_OFFSET + 32));
      if (baseVaultKey.equals(PublicKey.default) || quoteVaultKey.equals(PublicKey.default)) return null;
      return { baseVault: baseVaultKey.toBase58(), quoteVault: quoteVaultKey.toBase58() };
    } catch {
      return null;
    }
  }

  // SPL token account layout: [32] mint, [32] owner, [8] amount (u64 LE) at offset 64
  private readTokenAccountAmount(data: Buffer): number | null {
    if (data.length < 72) return null;
    try {
      return new BN(data.subarray(64, 72), 'le').toNumber();
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
