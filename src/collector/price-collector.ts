import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import {
  insertPoolObservation,
  markObservationComplete,
  updateMomentumPrice,
  updateMomentumOpenPrice,
} from '../db/queries';
import { MomentumLabeler } from '../analysis/momentum-labeler';
import { CompetitionDetector } from './competition-detector';
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = pino({ name: 'price-collector' });

// Momentum research schedule: T+0 for open price, then checkpoints for price tracking
const SNAPSHOT_SCHEDULE = [0, 30, 60, 120, 300, 600];

// Map snapshot seconds to momentum checkpoint column names
const CHECKPOINT_MAP: Record<number, 't30' | 't60' | 't120' | 't300' | 't600'> = {
  30: 't30',
  60: 't60',
  120: 't120',
  300: 't300',
  600: 't600',
};

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
  private momentumLabeler: MomentumLabeler;
  private competitionDetector: CompetitionDetector;
  private totalObservationsStarted = 0;
  private totalObservationsCompleted = 0;
  private totalSnapshots = 0;
  private totalSnapshotFailures = 0;
  private lastSnapshotFailures: Array<{ graduationId: number; targetSec: number; reason: string; time: string }> = [];

  constructor(db: Database.Database, connection: Connection) {
    this.db = db;
    this.connection = connection;
    this.momentumLabeler = new MomentumLabeler(db);
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
      totalSnapshotFailures: this.totalSnapshotFailures,
      lastSnapshotFailures: this.lastSnapshotFailures.slice(-5),
    };
  }

  private recordSnapshotFailure(graduationId: number, targetSec: number, reason: string): void {
    this.totalSnapshotFailures++;
    this.lastSnapshotFailures.push({
      graduationId,
      targetSec,
      reason,
      time: new Date().toISOString(),
    });
    // Keep only last 20
    if (this.lastSnapshotFailures.length > 20) {
      this.lastSnapshotFailures = this.lastSnapshotFailures.slice(-20);
    }
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
        this.recordSnapshotFailure(graduationId, targetSec, `pool_fetch_null pool=${ctx.poolAddress.slice(0, 8)}`);
        logger.warn(
          { graduationId, targetSec, pool: ctx.poolAddress },
          'Could not fetch pool state for snapshot'
        );
        return;
      }

      this.totalSnapshots++;
      observation.completedSnapshots.push(targetSec);

      // Insert pool observation (raw data for debugging)
      insertPoolObservation(this.db, {
        graduation_id: graduationId,
        timestamp: now,
        seconds_since_graduation: actualSecSinceGraduation,
        pool_price_sol: poolState.price,
        pool_sol_reserves: poolState.solReserves,
        pool_token_reserves: poolState.tokenReserves,
      });

      // T+0 snapshot: set open price in graduation_momentum
      if (targetSec === 0 || observation.completedSnapshots.length === 1) {
        updateMomentumOpenPrice(this.db, graduationId, poolState.price);
        logger.info(
          { graduationId, mint: ctx.mint, openPrice: poolState.price.toFixed(12) },
          'Open price set'
        );
      }

      // Momentum checkpoint: find the closest matching checkpoint for this snapshot
      const checkpoint = this.findCheckpoint(targetSec);
      if (checkpoint && ctx.bondingCurvePrice > 0) {
        // Use bonding curve price as the "open" reference for pct change
        // (more reliable than the T+0 pool price which may not be available)
        const openRef = ctx.bondingCurvePrice;
        const pctChange = ((poolState.price - openRef) / openRef) * 100;
        updateMomentumPrice(this.db, graduationId, checkpoint, poolState.price, pctChange);
        logger.info(
          {
            graduationId,
            mint: ctx.mint,
            checkpoint,
            price: poolState.price.toFixed(12),
            pctChange: pctChange.toFixed(1),
          },
          'Momentum checkpoint recorded'
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

  /**
   * Map actual snapshot time to the nearest momentum checkpoint.
   * Returns null for T+0 (handled separately as open price).
   */
  private findCheckpoint(targetSec: number): 't30' | 't60' | 't120' | 't300' | 't600' | null {
    // Direct match
    if (CHECKPOINT_MAP[targetSec]) return CHECKPOINT_MAP[targetSec];
    // For the immediate/T+0 snapshot, no checkpoint
    if (targetSec < 15) return null;
    // Find closest checkpoint within 50% tolerance
    for (const [sec, name] of Object.entries(CHECKPOINT_MAP)) {
      const s = parseInt(sec, 10);
      if (Math.abs(targetSec - s) <= s * 0.5) return name as any;
    }
    return null;
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
        // Use pre-extracted vaults from migration tx if available
        if (ctx.baseVault && ctx.quoteVault) {
          observation.baseVault = ctx.baseVault;
          observation.quoteVault = ctx.quoteVault;
          logger.info(
            { graduationId: ctx.graduationId, baseVault: ctx.baseVault, quoteVault: ctx.quoteVault },
            'Using vault addresses from migration tx'
          );
        } else {
        if (!await globalRpcLimiter.throttleOrDrop(15)) {
          this.recordSnapshotFailure(ctx.graduationId, -1, 'rpc_queue_full_pool_decode');
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
          this.recordSnapshotFailure(ctx.graduationId, -1, `pool_not_found pool=${ctx.poolAddress}`);
          logger.warn({ graduationId: ctx.graduationId, pool: ctx.poolAddress }, 'Pool account not found');
          return null;
        }
        // Ensure data is a Buffer — Helius may return it as a string or array in some configurations
        const rawData = Array.isArray(poolInfo.data)
          ? Buffer.from(poolInfo.data[0] as string, 'base64')
          : Buffer.isBuffer(poolInfo.data)
            ? poolInfo.data
            : Buffer.from(poolInfo.data as unknown as Uint8Array);
        const vaults = this.parseVaultAddresses(rawData);
        if (!vaults) {
          const hexSample = rawData.length >= 145
            ? rawData.subarray(139, 145).toString('hex')
            : 'short';
          this.recordSnapshotFailure(ctx.graduationId, -1, `vault_parse_fail dataLen=${rawData.length}`);
          logger.warn(
            { graduationId: ctx.graduationId },
            `Could not parse vault addresses: dataLen=${rawData.length} bytes@139=${hexSample} pool=${ctx.poolAddress.slice(0, 8)}`
          );
          return null;
        }
        observation.baseVault = vaults.baseVault;
        observation.quoteVault = vaults.quoteVault;
        logger.info(
          { graduationId: ctx.graduationId, baseVault: vaults.baseVault, quoteVault: vaults.quoteVault },
          'Pool vault addresses decoded from pool account'
        );
        } // end else (no pre-extracted vaults)
      }

      // Fetch both vault balances in a single RPC call
      if (!await globalRpcLimiter.throttleOrDrop(15)) {
        this.recordSnapshotFailure(ctx.graduationId, -1, 'rpc_queue_full_vault_fetch');
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
        this.recordSnapshotFailure(ctx.graduationId, -1, `vault_data_missing base=${!!vaultAccounts[0]?.data} quote=${!!vaultAccounts[1]?.data}`);
        return null;
      }

      const baseAmount = this.readTokenAccountAmount(vaultAccounts[0].data as Buffer);
      const quoteAmount = this.readTokenAccountAmount(vaultAccounts[1].data as Buffer);

      if (baseAmount === null || quoteAmount === null || baseAmount === 0 || quoteAmount === 0) {
        this.recordSnapshotFailure(ctx.graduationId, -1, `vault_amounts_bad base=${baseAmount} quote=${quoteAmount}`);
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

    // Label momentum (PUMP/DUMP/STABLE)
    try {
      this.momentumLabeler.label(graduationId);
    } catch (err) {
      logger.error(
        'Momentum labeling failed for grad %d: %s',
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
