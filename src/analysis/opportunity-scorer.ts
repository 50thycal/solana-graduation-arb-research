import Database from 'better-sqlite3';
import pino from 'pino';
import {
  getPriceComparisons,
  getCompetitionCount10s,
  insertOpportunity,
} from '../db/queries';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'opportunity-scorer' });

// Cost estimates for Solana transactions
const ESTIMATED_GAS_SOL = 0.000005; // ~5000 lamports base fee
const ESTIMATED_JITO_TIP_SOL = 0.001; // Typical Jito tip for priority
const ESTIMATED_SLIPPAGE_PCT = 1.0; // 1% slippage assumption
const TRADE_SIZE_SOL = 0.1; // Simulated trade size

export class OpportunityScorer {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  scoreOpportunity(graduationId: number): void {
    const comparisons = getPriceComparisons(this.db, graduationId);

    if (comparisons.length === 0) {
      logger.debug({ graduationId }, 'No price comparisons to score');
      return;
    }

    // Extract spread data points
    const spreads = comparisons
      .filter((c) => c.bc_to_dex_spread_pct != null)
      .map((c) => ({
        seconds: c.seconds_since_graduation,
        spreadPct: c.bc_to_dex_spread_pct!,
        timestamp: c.timestamp,
      }));

    if (spreads.length === 0) {
      logger.debug({ graduationId }, 'No spread data to score');
      return;
    }

    // Find max spread
    let maxSpread = spreads[0];
    for (const s of spreads) {
      if (Math.abs(s.spreadPct) > Math.abs(maxSpread.spreadPct)) {
        maxSpread = s;
      }
    }

    // Calculate durations above thresholds
    const durationAbove05 = this.calcDurationAboveThreshold(spreads, 0.5);
    const durationAbove1 = this.calcDurationAboveThreshold(spreads, 1.0);
    const durationAbove2 = this.calcDurationAboveThreshold(spreads, 2.0);

    // Calculate spread collapse time (time from max spread to < 0.5%)
    let spreadCollapseSec: number | undefined;
    const maxSpreadIdx = spreads.indexOf(maxSpread);
    for (let i = maxSpreadIdx + 1; i < spreads.length; i++) {
      if (Math.abs(spreads[i].spreadPct) < 0.5) {
        spreadCollapseSec = spreads[i].seconds - maxSpread.seconds;
        break;
      }
    }

    // Estimate profit
    const absMaxSpread = Math.abs(maxSpread.spreadPct);
    const grossProfitPct = absMaxSpread - ESTIMATED_SLIPPAGE_PCT;
    const grossProfitSol = (grossProfitPct / 100) * TRADE_SIZE_SOL;
    const totalFees = ESTIMATED_GAS_SOL + ESTIMATED_JITO_TIP_SOL;
    const netProfitSol = grossProfitSol - totalFees;

    // Check fillability (is there enough liquidity?)
    const firstObs = comparisons[0];
    const availableLiquidity = (firstObs as any).pool_sol_reserves || 0;
    const isFillable = availableLiquidity >= TRADE_SIZE_SOL ? 1 : 0;

    // Competition count
    const competitionCount = getCompetitionCount10s(this.db, graduationId);

    // Viability score (0-100)
    let viabilityScore = 0;
    if (absMaxSpread > 0.5) viabilityScore += 20;
    if (absMaxSpread > 1.0) viabilityScore += 20;
    if (absMaxSpread > 2.0) viabilityScore += 15;
    if (durationAbove1 > 1) viabilityScore += 15;
    if (durationAbove1 > 5) viabilityScore += 10;
    if (netProfitSol > 0) viabilityScore += 10;
    if (competitionCount < 5) viabilityScore += 5;
    if (isFillable) viabilityScore += 5;

    // Classification
    let classification: string;
    if (viabilityScore >= 70) {
      classification = 'high-opportunity';
    } else if (viabilityScore >= 40) {
      classification = 'moderate-opportunity';
    } else if (viabilityScore >= 20) {
      classification = 'low-opportunity';
    } else {
      classification = 'no-opportunity';
    }

    insertOpportunity(this.db, {
      graduation_id: graduationId,
      max_spread_pct: maxSpread.spreadPct,
      max_spread_timestamp: maxSpread.timestamp,
      seconds_to_max_spread: maxSpread.seconds,
      duration_above_05_pct: durationAbove05,
      duration_above_1_pct: durationAbove1,
      duration_above_2_pct: durationAbove2,
      spread_collapse_seconds: spreadCollapseSec,
      estimated_profit_sol: grossProfitSol,
      estimated_gas_sol: ESTIMATED_GAS_SOL,
      estimated_jito_tip_sol: ESTIMATED_JITO_TIP_SOL,
      estimated_slippage_pct: ESTIMATED_SLIPPAGE_PCT,
      net_profit_sol: netProfitSol,
      is_fillable: isFillable,
      available_liquidity_sol: availableLiquidity,
      competition_tx_count_10s: competitionCount,
      viability_score: viabilityScore,
      classification,
    });

    logger.info(
      {
        graduationId,
        maxSpreadPct: maxSpread.spreadPct.toFixed(2),
        secondsToMax: maxSpread.seconds,
        durationAbove1pct: durationAbove1.toFixed(1),
        netProfitSol: netProfitSol.toFixed(6),
        competitionCount,
        viabilityScore,
        classification,
      },
      'Opportunity scored'
    );
  }

  private calcDurationAboveThreshold(
    spreads: Array<{ seconds: number; spreadPct: number }>,
    thresholdPct: number
  ): number {
    // Estimate duration by looking at time intervals where spread exceeds threshold
    let totalDuration = 0;

    for (let i = 0; i < spreads.length - 1; i++) {
      if (Math.abs(spreads[i].spreadPct) >= thresholdPct) {
        const intervalSec = spreads[i + 1].seconds - spreads[i].seconds;
        totalDuration += intervalSec;
      }
    }

    // Handle last data point
    if (spreads.length > 0 && Math.abs(spreads[spreads.length - 1].spreadPct) >= thresholdPct) {
      // Assume it lasted at least 1 second
      totalDuration += 1;
    }

    return totalDuration;
  }
}
