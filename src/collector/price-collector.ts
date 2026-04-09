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

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'price-collector' });

// Momentum research schedule: T+0 for open price, then checkpoints for price tracking.
// Every 5s for the first 60s (for price path shape analysis), then every 30s until T+300,
// then T+600 for final state.
const SNAPSHOT_SCHEDULE = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 90, 120, 150, 180, 240, 300, 600];

// Map snapshot seconds to momentum checkpoint column names
const CHECKPOINT_MAP: Record<number, string> = {
  5:  't5',
  10: 't10',
  15: 't15',
  20: 't20',
  25: 't25',
  30: 't30',
  35: 't35',
  40: 't40',
  45: 't45',
  50: 't50',
  55: 't55',
  60: 't60',
  90: 't90',
  120: 't120',
  150: 't150',
  180: 't180',
  240: 't240',
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
  // Bonding curve PDA — used as fallback for token age / velocity calculation
  bondingCurveAddress?: string;
}

// PumpFun graduation threshold is fixed at ~85 SOL — used as fallback when
// total_sol_raised is unexpectedly null.
const PUMP_GRADUATION_SOL = 85;

interface ActiveObservation {
  ctx: ObservationContext;
  startedAt: number;
  scheduledSnapshots: number[];
  completedSnapshots: number[];
  timers: NodeJS.Timeout[];
  // Cached after first successful pool decode — avoids re-fetching pool account on every snapshot
  baseVault?: string;
  quoteVault?: string;
  // T+0 pool price — used as reference for pct change calculations
  openPoolPrice?: number;
  // Peak/drawdown tracking for max drawdown analysis
  peakPricePct: number;    // highest pct change seen so far
  peakPriceSec: number;    // when peak occurred (seconds since graduation)
  maxDrawdownPct: number;  // worst drop from peak (negative number)
  maxDrawdownSec: number;  // when max drawdown occurred
  // Price history for volatility/liquidity tracking (first 30s)
  earlyPrices: number[];         // all prices seen T+0 to T+30
  earlySolReserves: number[];    // SOL reserves at each early snapshot
  liquiditySolT30?: number;      // SOL reserves at T+30
}

// ── Price path shape helpers ─────────────────────────────────────────────────
// All functions accept an array of pct-change values at uniform intervals.

/** Fraction of consecutive intervals where price increased (0.0 – 1.0). */
function computeMonotonicity(pcts: number[]): number {
  if (pcts.length < 2) return 0;
  let positive = 0;
  for (let i = 1; i < pcts.length; i++) {
    if (pcts[i] > pcts[i - 1]) positive++;
  }
  return positive / (pcts.length - 1);
}

/** Std dev of interval-to-interval returns (measures choppiness). */
function computePathSmoothness(pcts: number[]): number {
  if (pcts.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < pcts.length; i++) diffs.push(pcts[i] - pcts[i - 1]);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
  return Math.sqrt(variance);
}

/** Max peak-to-trough % drop along the path (always ≤ 0). */
function computeMaxDrawdown(pcts: number[]): number {
  let peak = pcts[0];
  let maxDD = 0;
  for (const p of pcts) {
    if (p > peak) peak = p;
    const dd = p - peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * Returns 1 if price dropped more than `threshold`% from a running peak
 * and then subsequently recovered above that same peak; 0 otherwise.
 */
function computeDipAndRecover(pcts: number[], threshold = 10): number {
  let peak = pcts[0];
  let dippedBelow = false;
  let peakAtDip = 0;
  for (const p of pcts) {
    if (p > peak) {
      if (dippedBelow && p > peakAtDip) return 1;
      peak = p;
      dippedBelow = false;
    } else if (peak - p > threshold) {
      if (!dippedBelow) { dippedBelow = true; peakAtDip = peak; }
    }
  }
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────

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
  private onT30Callback?: (
    graduationId: number,
    ctx: ObservationContext,
    priceT30: number,
    pctT30: number,
    solReservesSol: number,
  ) => void;

  /** Register a callback invoked at T+30 after graduation_momentum metrics are written. */
  setT30Callback(cb: (
    graduationId: number,
    ctx: ObservationContext,
    priceT30: number,
    pctT30: number,
    solReservesSol: number,
  ) => void): void {
    this.onT30Callback = cb;
  }

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
      peakPricePct: 0,
      peakPriceSec: 0,
      maxDrawdownPct: 0,
      maxDrawdownSec: 0,
      earlyPrices: [],
      earlySolReserves: [],
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

    // Schedule buy pressure quality detection at T+35 (full 0-30s window + 5s buffer)
    const buyPressureDelay = (35 - elapsedSec) * 1000;
    if (buyPressureDelay > 0) {
      const bpTimer = setTimeout(() => {
        this.competitionDetector.detectBuyPressure(ctx).catch((err) => {
          logger.error(
            'Buy pressure detection failed for grad %d: %s',
            ctx.graduationId,
            err instanceof Error ? err.message : String(err)
          );
        });
      }, buyPressureDelay);
      observation.timers.push(bpTimer);
    } else {
      // Already past 35s, run immediately
      this.competitionDetector.detectBuyPressure(ctx).catch(() => {});
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

      // Track early prices/liquidity for volatility and slippage estimation
      if (targetSec <= 30) {
        observation.earlyPrices.push(poolState.price);
        observation.earlySolReserves.push(poolState.solReserves);
      }

      // At T+30: compute volatility, liquidity, and slippage estimates
      if (targetSec === 30 && observation.openPoolPrice && observation.openPoolPrice > 0) {
        observation.liquiditySolT30 = poolState.solReserves;

        const prices = observation.earlyPrices;
        if (prices.length >= 2) {
          const minPrice = Math.min(...prices);
          const maxPrice = Math.max(...prices);
          const volatility = ((maxPrice - minPrice) / observation.openPoolPrice) * 100;

          // Realistic slippage estimate for a 0.5 SOL buy:
          // AMM price impact = trade_size / (pool_sol + trade_size)
          // + PumpSwap fee (~0.25%)
          // + estimated execution overhead (~1.5% for priority fees, MEV, confirmation delay)
          // This gives a conservative estimate closer to real-world execution.
          const tradeSizeSol = 0.5;
          const ammImpact = (tradeSizeSol / (poolState.solReserves + tradeSizeSol)) * 100;
          const swapFee = 0.25;
          const executionOverhead = 1.5;
          const slippagePct = ammImpact + swapFee + executionOverhead;
          // Conservative round-trip: exit slippage ≈ entry slippage (pool liquidity may be
          // lower at T+300, so this is not an overestimate). For a more precise estimate
          // we'd need to capture pool reserves at T+300 (liquidity_sol_t300).
          const roundTripSlippagePct = slippagePct * 2;

          try {
            this.db.prepare(`
              UPDATE graduation_momentum
              SET volatility_0_30 = ?, liquidity_sol_t30 = ?, slippage_est_05sol = ?, round_trip_slippage_pct = ?
              WHERE graduation_id = ?
            `).run(
              +volatility.toFixed(2),
              +poolState.solReserves.toFixed(4),
              +slippagePct.toFixed(3),
              +roundTripSlippagePct.toFixed(3),
              graduationId
            );
          } catch (err) {
            logger.warn('Failed to write T+30 liquidity metrics for grad %d: %s',
              graduationId, err instanceof Error ? err.message : String(err));
          }
        }
      }

      // Insert pool observation (raw data for debugging)
      insertPoolObservation(this.db, {
        graduation_id: graduationId,
        timestamp: now,
        seconds_since_graduation: actualSecSinceGraduation,
        pool_price_sol: poolState.price,
        pool_sol_reserves: poolState.solReserves,
        pool_token_reserves: poolState.tokenReserves,
      });

      // T+0 snapshot: set open price from first successful pool price read
      if (!observation.openPoolPrice) {
        observation.openPoolPrice = poolState.price;
        updateMomentumOpenPrice(this.db, graduationId, poolState.price);
        logger.info(
          { graduationId, mint: ctx.mint, openPrice: poolState.price.toFixed(12) },
          'Open pool price set'
        );
      }

      // Momentum checkpoint: compute pct change relative to T+0 POOL price (not BC price)
      const checkpoint = this.findCheckpoint(targetSec);
      if (checkpoint && observation.openPoolPrice > 0) {
        const openRef = observation.openPoolPrice;
        const pctChange = ((poolState.price - openRef) / openRef) * 100;
        updateMomentumPrice(this.db, graduationId, checkpoint, poolState.price, pctChange);

        // Track peak and max drawdown
        if (pctChange > observation.peakPricePct) {
          observation.peakPricePct = pctChange;
          observation.peakPriceSec = targetSec;
        }
        const drawdownFromPeak = pctChange - observation.peakPricePct;
        if (drawdownFromPeak < observation.maxDrawdownPct) {
          observation.maxDrawdownPct = drawdownFromPeak;
          observation.maxDrawdownSec = targetSec;
        }

        logger.info(
          {
            graduationId,
            mint: ctx.mint,
            checkpoint,
            price: poolState.price.toFixed(12),
            openRef: openRef.toFixed(12),
            pctChange: pctChange.toFixed(1),
          },
          'Momentum checkpoint recorded'
        );

        // Compute derived path shape metrics at T+30 (pct_t30 is now in DB)
        if (targetSec === 30) {
          this.computeT30PathMetrics(graduationId);
          // Fire trading engine callback — all T+30 momentum fields are now written
          if (this.onT30Callback) {
            this.onT30Callback(graduationId, ctx, poolState.price, pctChange, poolState.solReserves);
          }
        }

        // Compute derived path shape metrics at T+60 (pct_t60 is now in DB)
        if (targetSec === 60) {
          this.computeT60PathMetrics(graduationId);
        }
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
  private findCheckpoint(targetSec: number): string | null {
    // Direct match
    if (CHECKPOINT_MAP[targetSec]) return CHECKPOINT_MAP[targetSec];
    // For the immediate/T+0 snapshot (targetSec ~0-3), no checkpoint
    if (targetSec < 3) return null;
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
        // Also write back onto ctx so any consumer of the ObservationContext
        // (e.g. the TradingEngine T+30 callback) sees the resolved vaults.
        ctx.baseVault = vaults.baseVault;
        ctx.quoteVault = vaults.quoteVault;
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

  /** Compute and persist path shape metrics based on T+0 – T+30 pct snapshots. */
  private computeT30PathMetrics(graduationId: number): void {
    try {
      const row = this.db.prepare(`
        SELECT pct_t5, pct_t10, pct_t15, pct_t20, pct_t25, pct_t30
        FROM graduation_momentum WHERE graduation_id = ?
      `).get(graduationId) as any;

      if (!row || row.pct_t30 == null) return;

      // Build ordered pct array: [0, t5, t10, t15, t20, t25, t30], skipping nulls
      const allPcts: (number | null)[] = [
        0, row.pct_t5, row.pct_t10, row.pct_t15, row.pct_t20, row.pct_t25, row.pct_t30,
      ];
      const valid = allPcts.filter(p => p !== null) as number[];
      if (valid.length < 3) return;

      const acceleration_t30 =
        row.pct_t25 != null && row.pct_t20 != null
          ? (row.pct_t30 - row.pct_t25) - (row.pct_t25 - row.pct_t20)
          : null;

      const monotonicity_0_30   = computeMonotonicity(valid);
      const path_smoothness_0_30 = computePathSmoothness(valid);
      const max_drawdown_0_30   = computeMaxDrawdown(valid);
      const dip_and_recover_flag = computeDipAndRecover(valid);

      // Front-loaded (+) vs back-loaded (-): first half gain minus second half gain
      const early_vs_late_0_30 =
        row.pct_t15 != null
          ? row.pct_t15 - (row.pct_t30 - row.pct_t15)
          : null;

      this.db.prepare(`
        UPDATE graduation_momentum
        SET acceleration_t30     = ?,
            monotonicity_0_30    = ?,
            path_smoothness_0_30 = ?,
            max_drawdown_0_30    = ?,
            dip_and_recover_flag = ?,
            early_vs_late_0_30   = ?
        WHERE graduation_id = ?
      `).run(
        acceleration_t30 != null ? +acceleration_t30.toFixed(3) : null,
        +monotonicity_0_30.toFixed(3),
        +path_smoothness_0_30.toFixed(3),
        +max_drawdown_0_30.toFixed(3),
        dip_and_recover_flag,
        early_vs_late_0_30 != null ? +early_vs_late_0_30.toFixed(3) : null,
        graduationId,
      );

      logger.debug({ graduationId, acceleration_t30, monotonicity_0_30: +monotonicity_0_30.toFixed(3) }, 'T+30 path metrics computed');
    } catch (err) {
      logger.warn('Failed to compute T+30 path metrics for grad %d: %s', graduationId,
        err instanceof Error ? err.message : String(err));
    }
  }

  /** Compute and persist path shape metrics based on T+0 – T+60 pct snapshots. */
  private computeT60PathMetrics(graduationId: number): void {
    try {
      const row = this.db.prepare(`
        SELECT pct_t5, pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
               pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60
        FROM graduation_momentum WHERE graduation_id = ?
      `).get(graduationId) as any;

      if (!row || row.pct_t60 == null) return;

      const allPcts: (number | null)[] = [
        0,
        row.pct_t5,  row.pct_t10, row.pct_t15, row.pct_t20, row.pct_t25, row.pct_t30,
        row.pct_t35, row.pct_t40, row.pct_t45, row.pct_t50, row.pct_t55, row.pct_t60,
      ];
      const valid = allPcts.filter(p => p !== null) as number[];
      if (valid.length < 5) return;

      const acceleration_t60 =
        row.pct_t55 != null && row.pct_t50 != null
          ? (row.pct_t60 - row.pct_t55) - (row.pct_t55 - row.pct_t50)
          : null;

      const monotonicity_0_60   = computeMonotonicity(valid);
      const path_smoothness_0_60 = computePathSmoothness(valid);
      const max_drawdown_0_60   = computeMaxDrawdown(valid);

      // Front half (0→30) vs back half (30→60)
      const early_vs_late_0_60 =
        row.pct_t30 != null
          ? row.pct_t30 - (row.pct_t60 - row.pct_t30)
          : null;

      this.db.prepare(`
        UPDATE graduation_momentum
        SET acceleration_t60     = ?,
            monotonicity_0_60    = ?,
            path_smoothness_0_60 = ?,
            max_drawdown_0_60    = ?,
            early_vs_late_0_60   = ?
        WHERE graduation_id = ?
      `).run(
        acceleration_t60 != null ? +acceleration_t60.toFixed(3) : null,
        +monotonicity_0_60.toFixed(3),
        +path_smoothness_0_60.toFixed(3),
        +max_drawdown_0_60.toFixed(3),
        early_vs_late_0_60 != null ? +early_vs_late_0_60.toFixed(3) : null,
        graduationId,
      );

      logger.debug({ graduationId, acceleration_t60, monotonicity_0_60: +monotonicity_0_60.toFixed(3) }, 'T+60 path metrics computed');
    } catch (err) {
      logger.warn('Failed to compute T+60 path metrics for grad %d: %s', graduationId,
        err instanceof Error ? err.message : String(err));
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

    // Write peak/drawdown metrics
    if (observation.openPoolPrice && observation.openPoolPrice > 0) {
      try {
        this.db.prepare(`
          UPDATE graduation_momentum
          SET max_peak_pct = ?, max_peak_sec = ?, max_drawdown_pct = ?, max_drawdown_sec = ?
          WHERE graduation_id = ?
        `).run(
          observation.peakPricePct,
          observation.peakPriceSec,
          observation.maxDrawdownPct,
          observation.maxDrawdownSec,
          graduationId
        );
      } catch (err) {
        logger.error(
          'Failed to write drawdown metrics for grad %d: %s',
          graduationId,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Compute and store bonding curve velocity (sol_raised / age_minutes)
    this.computeAndStoreVelocity(graduationId, observation.ctx.mint, observation.ctx.graduationTimestamp, observation.ctx.bondingCurveAddress);

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

    // After each labeled graduation, sweep for any completed tokens that still
    // have null velocity (covers restarts, missed observations, etc.)
    this.runVelocityRecoverySweep().catch(() => {});

    logger.info(
      {
        graduationId,
        mint: observation.ctx.mint,
        completedSnapshots: observation.completedSnapshots.length,
        totalCompleted: this.totalObservationsCompleted,
        maxPeakPct: observation.peakPricePct.toFixed(1),
        maxDrawdownPct: observation.maxDrawdownPct.toFixed(1),
        maxDrawdownSec: observation.maxDrawdownSec,
      },
      'Observation complete'
    );
  }

  /**
   * Compute bc_velocity_sol_per_min from total_sol_raised and token_age_seconds.
   *
   * The enrichment step (holder-enrichment.ts) now resolves token_age_seconds
   * directly from the bonding curve signature history without throttleOrDrop, so
   * nulls should be rare. If age is still missing here (e.g. enrichment ran before
   * pool was ready, or RPC hiccup), we do ONE direct fallback fetch on the BC address.
   * sol_raised falls back to the known PumpFun graduation threshold (85 SOL).
   */
  private computeAndStoreVelocity(graduationId: number, mint: string, graduationTimestamp: number, bondingCurveAddress?: string): void {
    try {
      const row = this.db.prepare(
        'SELECT total_sol_raised, token_age_seconds FROM graduation_momentum WHERE graduation_id = ?'
      ).get(graduationId) as any;

      if (!row) {
        logger.warn({ graduationId }, 'bc_velocity: no momentum row found');
        return;
      }

      const solRaised = (row.total_sol_raised > 0) ? row.total_sol_raised : PUMP_GRADUATION_SOL;

      if (row.token_age_seconds > 0) {
        const rawVelocity = (solRaised / row.token_age_seconds) * 60;
        // Cap at 500 sol/min (≈ graduation in <10s = bot rush / instant fill).
        // Uncapped values (e.g. 5000+ sol/min) destroy moving averages and filter UX.
        const velocity = Math.min(rawVelocity, 500);
        this.db.prepare(
          'UPDATE graduation_momentum SET bc_velocity_sol_per_min = ? WHERE graduation_id = ?'
        ).run(+velocity.toFixed(2), graduationId);
        logger.info({ graduationId, velocity: +velocity.toFixed(2), rawVelocity: +rawVelocity.toFixed(2) }, 'bc_velocity computed');
        return;
      }

      // token_age_seconds still null — do one direct BC lookup as a last-resort fallback
      if (!bondingCurveAddress) {
        logger.warn({ graduationId, mint: mint.slice(0, 8) }, 'bc_velocity: token_age_seconds null and no bondingCurveAddress for fallback');
        return;
      }

      logger.info({ graduationId, mint: mint.slice(0, 8) }, 'bc_velocity: token_age_seconds null at T+300, doing direct BC age lookup');
      this.fallbackAgeLookup(graduationId, bondingCurveAddress, graduationTimestamp, solRaised);
    } catch (err) {
      logger.warn('Failed to compute bc_velocity for grad %d: %s', graduationId,
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Last-resort: walk BC signatures directly (no throttleOrDrop) to recover age.
   * Only called when token_age_seconds is still null at T+300s.
   */
  private async fallbackAgeLookup(
    graduationId: number, bondingCurveAddress: string, graduationTimestamp: number, solRaised: number
  ): Promise<void> {
    try {
      const bcPubkey = new PublicKey(bondingCurveAddress);
      let before: string | undefined = undefined;
      let oldestBlockTime: number | null = null;

      for (let page = 0; page < 3; page++) {
        const sigs = await this.connection.getSignaturesForAddress(bcPubkey, { limit: 1000, before });
        if (sigs.length === 0) break;
        const last = sigs[sigs.length - 1];
        if (last.blockTime) oldestBlockTime = last.blockTime;
        if (sigs.length < 1000) break;
        before = last.signature;
      }

      if (oldestBlockTime === null) {
        logger.warn({ graduationId }, 'bc_velocity fallback: could not determine BC creation time');
        return;
      }

      const rawAge = graduationTimestamp - oldestBlockTime;
      if (rawAge < 0) {
        logger.warn({ graduationId, graduationTimestamp, oldestBlockTime }, 'bc_velocity fallback: oldestBlockTime is after graduation — skipping');
        return;
      }
      // Minimum 1s: instant-graduation (sniped in same block) has rawAge=0, still valid.
      const tokenAgeSeconds = Math.max(1, rawAge);

      this.db.prepare(
        'UPDATE graduation_momentum SET token_age_seconds = ? WHERE graduation_id = ? AND token_age_seconds IS NULL'
      ).run(tokenAgeSeconds, graduationId);
      this.db.prepare(
        'UPDATE graduations SET token_age_seconds = ? WHERE id = ? AND token_age_seconds IS NULL'
      ).run(tokenAgeSeconds, graduationId);

      const velocity = Math.min((solRaised / tokenAgeSeconds) * 60, 500);
      this.db.prepare(
        'UPDATE graduation_momentum SET bc_velocity_sol_per_min = ? WHERE graduation_id = ?'
      ).run(+velocity.toFixed(2), graduationId);

      logger.info(
        { graduationId, tokenAgeSeconds, velocity: +velocity.toFixed(2) },
        'bc_velocity recovered via fallback BC lookup'
      );
    } catch (err) {
      logger.warn('bc_velocity fallback failed for grad %d: %s', graduationId,
        err instanceof Error ? err.message : String(err));
    }
  }

  private velocityRecoveryRunning = false;

  /**
   * Scan for completed observations (labeled OR price_t300 captured) that still have
   * null velocity and fix them. Called automatically after each graduation is labeled.
   * A guard flag prevents overlapping runs if graduations complete close together.
   * Also called once at startup to recover anything missed during the previous session.
   */
  private async runVelocityRecoverySweep(): Promise<void> {
    if (this.velocityRecoveryRunning) return;
    this.velocityRecoveryRunning = true;

    try {
      const candidates = this.db.prepare(`
        SELECT gm.graduation_id, g.bonding_curve_address, g.timestamp AS grad_timestamp,
               gm.total_sol_raised, gm.token_age_seconds
        FROM graduation_momentum gm
        JOIN graduations g ON g.id = gm.graduation_id
        WHERE gm.bc_velocity_sol_per_min IS NULL
          AND (gm.label IS NOT NULL OR gm.price_t300 IS NOT NULL)
          AND gm.total_sol_raised > 0
      `).all() as Array<{
        graduation_id: number;
        bonding_curve_address: string | null;
        grad_timestamp: number;
        total_sol_raised: number;
        token_age_seconds: number | null;
      }>;

      if (candidates.length === 0) return;

      logger.info({ count: candidates.length }, 'Velocity recovery sweep: fixing null velocity on completed observations');

      for (const row of candidates) {
        const solRaised = row.total_sol_raised || PUMP_GRADUATION_SOL;

        // Age already stored — compute velocity instantly, no RPC needed
        if (row.token_age_seconds && row.token_age_seconds > 0) {
          const velocity = Math.min((solRaised / row.token_age_seconds) * 60, 500);
          this.db.prepare(
            'UPDATE graduation_momentum SET bc_velocity_sol_per_min = ? WHERE graduation_id = ?'
          ).run(+velocity.toFixed(2), row.graduation_id);
          logger.info({ graduationId: row.graduation_id, velocity: +velocity.toFixed(2) }, 'Velocity recovery: computed from stored age');
          continue;
        }

        // Need BC creation time — skip if no address stored
        if (!row.bonding_curve_address) {
          logger.warn({ graduationId: row.graduation_id }, 'Velocity recovery skip: no bonding_curve_address stored');
          continue;
        }
        if (!row.grad_timestamp) {
          logger.warn({ graduationId: row.graduation_id }, 'Velocity recovery skip: no grad_timestamp');
          continue;
        }

        try {
          const bcPubkey = new PublicKey(row.bonding_curve_address);
          let oldestBlockTime: number | null = null;
          let before: string | undefined = undefined;
          let totalSigsScanned = 0;

          for (let page = 0; page < 5; page++) {
            const sigs = await this.connection.getSignaturesForAddress(bcPubkey, { limit: 1000, before });
            totalSigsScanned += sigs.length;
            if (sigs.length === 0) break;
            const last = sigs[sigs.length - 1];
            if (last.blockTime) oldestBlockTime = last.blockTime;
            if (sigs.length < 1000) break;
            before = last.signature;
            await new Promise(r => setTimeout(r, 200));
          }

          if (!oldestBlockTime) {
            logger.warn(
              { graduationId: row.graduation_id, bc: row.bonding_curve_address.slice(0, 8), totalSigsScanned },
              'Velocity recovery skip: no blockTime found in BC signature history'
            );
            continue;
          }

          const rawAge = row.grad_timestamp - oldestBlockTime;
          if (rawAge < 0) {
            logger.warn(
              { graduationId: row.graduation_id, grad_timestamp: row.grad_timestamp, oldestBlockTime, totalSigsScanned },
              'Velocity recovery skip: oldestBlockTime is after graduation — BC address may be wrong for this token'
            );
            continue;
          }
          // Minimum 1s: instant-graduation tokens sniped in same block have rawAge=0.
          const tokenAgeSeconds = Math.max(1, rawAge);

          const velocity = Math.min((solRaised / tokenAgeSeconds) * 60, 500);

          this.db.prepare(
            'UPDATE graduation_momentum SET token_age_seconds = ?, bc_velocity_sol_per_min = ? WHERE graduation_id = ? AND bc_velocity_sol_per_min IS NULL'
          ).run(tokenAgeSeconds, +velocity.toFixed(2), row.graduation_id);
          this.db.prepare(
            'UPDATE graduations SET token_age_seconds = ? WHERE id = ? AND token_age_seconds IS NULL'
          ).run(tokenAgeSeconds, row.graduation_id);

          logger.info(
            { graduationId: row.graduation_id, tokenAgeSeconds, velocity: +velocity.toFixed(2) },
            'Velocity recovery: recovered via BC lookup'
          );

          await new Promise(r => setTimeout(r, 300));
        } catch {
          // Silently skip — will retry on next graduation label
        }
      }
    } catch (err) {
      logger.warn('Velocity recovery sweep error: %s', err instanceof Error ? err.message : String(err));
    } finally {
      this.velocityRecoveryRunning = false;
    }
  }

  startAutoVelocityRecovery(): void {
    // Run once 60s after startup to catch anything missed during the previous session
    setTimeout(() => this.runVelocityRecoverySweep(), 60_000);
    logger.info('Velocity recovery: will run after each labeled graduation and once at startup');
  }
}
