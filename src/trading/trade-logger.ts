import Database from 'better-sqlite3';
import pino from 'pino';
import {
  insertTrade,
  closeTrade,
  markTradeFailed,
  insertTradeSkip,
  backfillTradeMomentum,
} from '../db/queries';
import { TradingConfig } from './config';
import { FilterStageResult } from './filter-pipeline';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'trade-logger' });

export interface OpenTradeParams {
  graduationId: number;
  mint: string;
  poolAddress: string;
  baseVault?: string;
  quoteVault?: string;
  entryPriceSol: number;
  entryPctFromOpen: number;
  entryLiquiditySol: number;
  filterStages: FilterStageResult[];
  config: TradingConfig;
}

export interface CloseTradeParams {
  tradeId: number;
  entryPriceSol: number;
  exitPriceSol: number;
  exitReason: 'take_profit' | 'stop_loss' | 'timeout' | 'manual';
  tradeSizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  slGapPenaltyPct: number;
  tpGapPenaltyPct: number;
  exitTxSignature?: string;
}

export class TradeLogger {
  constructor(private db: Database.Database) {}

  /**
   * Insert an open trade record. Returns the trade ID for position tracking.
   * Entry slippage is pulled from graduation_momentum.slippage_est_05sol if available.
   */
  openTrade(params: OpenTradeParams): number {
    // Try to fetch pre-computed slippage estimate from graduation_momentum
    let slippagePct: number | undefined;
    try {
      const row = this.db.prepare(
        'SELECT slippage_est_05sol FROM graduation_momentum WHERE graduation_id = ?'
      ).get(params.graduationId) as { slippage_est_05sol: number | null } | undefined;
      if (row?.slippage_est_05sol != null) {
        slippagePct = row.slippage_est_05sol;
      }
    } catch { /* non-critical */ }

    const tradeId = insertTrade(this.db, {
      graduation_id: params.graduationId,
      mode: params.config.mode,
      mint: params.mint,
      pool_address: params.poolAddress,
      base_vault: params.baseVault,
      quote_vault: params.quoteVault,
      entry_timestamp: Math.floor(Date.now() / 1000),
      entry_price_sol: params.entryPriceSol,
      entry_pct_from_open: params.entryPctFromOpen,
      entry_liquidity_sol: params.entryLiquiditySol,
      trade_size_sol: params.config.tradeSizeSol,
      take_profit_pct: params.config.takeProfitPct,
      stop_loss_pct: params.config.stopLossPct,
      max_hold_seconds: params.config.maxHoldSeconds,
      entry_slippage_pct: slippagePct,
      filter_results_json: JSON.stringify(params.filterStages),
      filter_config_json: JSON.stringify(params.config.filters),
    });

    logger.info(
      {
        tradeId,
        graduationId: params.graduationId,
        mint: params.mint,
        mode: params.config.mode,
        entryPriceSol: params.entryPriceSol,
        entryPctFromOpen: params.entryPctFromOpen.toFixed(1),
      },
      'Trade opened'
    );

    return tradeId;
  }

  /** Record the exit and compute all P&L fields */
  closeTrade(params: CloseTradeParams): void {
    const { entryPriceSol, exitPriceSol, exitReason } = params;

    const grossReturnPct = ((exitPriceSol - entryPriceSol) / entryPriceSol) * 100;

    // Apply gap penalty matching Panel 4 methodology:
    // SL exits: modelled as gapping 20% worse than trigger price
    // TP exits: modelled as gapping 10% worse than trigger price
    let effectiveExitPrice = exitPriceSol;
    if (exitReason === 'stop_loss') {
      effectiveExitPrice = exitPriceSol * (1 - params.slGapPenaltyPct / 100);
    } else if (exitReason === 'take_profit') {
      effectiveExitPrice = exitPriceSol * (1 - params.tpGapPenaltyPct / 100);
    }
    const gapAdjustedReturnPct = ((effectiveExitPrice - entryPriceSol) / entryPriceSol) * 100;

    // Round-trip fee estimate (use 1.75% as default if not computed per-trade)
    let roundTripCostPct = 1.75;
    try {
      const row = this.db.prepare(
        `SELECT t.entry_slippage_pct, gm.round_trip_slippage_pct
         FROM trades_v2 t
         LEFT JOIN graduation_momentum gm ON gm.graduation_id = t.graduation_id
         WHERE t.id = ?`
      ).get(params.tradeId) as any;
      if (row?.round_trip_slippage_pct != null) roundTripCostPct = row.round_trip_slippage_pct;
    } catch { /* use default */ }

    const estimatedFeesSol = params.tradeSizeSol * (roundTripCostPct / 100);
    const netReturnPct = gapAdjustedReturnPct - roundTripCostPct;
    const netProfitSol = params.tradeSizeSol * (netReturnPct / 100);

    closeTrade(this.db, params.tradeId, {
      exit_timestamp: Math.floor(Date.now() / 1000),
      exit_price_sol: exitPriceSol,
      exit_reason: exitReason,
      exit_effective_price: effectiveExitPrice,
      exit_tx_signature: params.exitTxSignature,
      gross_return_pct: grossReturnPct,
      gap_adjusted_return_pct: gapAdjustedReturnPct,
      estimated_fees_sol: estimatedFeesSol,
      net_profit_sol: netProfitSol,
      net_return_pct: netReturnPct,
    });

    logger.info(
      {
        tradeId: params.tradeId,
        exitReason,
        exitPriceSol,
        grossReturnPct: grossReturnPct.toFixed(2),
        netReturnPct: netReturnPct.toFixed(2),
      },
      'Trade closed'
    );
  }

  /** Mark a trade as failed (entry tx failed, etc.) */
  failTrade(tradeId: number, reason: string): void {
    markTradeFailed(this.db, tradeId, reason);
    logger.warn({ tradeId, reason }, 'Trade failed');
  }

  /** Log a graduation that was evaluated but not entered */
  logSkipped(
    graduationId: number,
    skipReason: string,
    skipValue: number | null,
    pctT30: number | null,
  ): void {
    insertTradeSkip(this.db, graduationId, skipReason, skipValue, pctT30);
    logger.debug({ graduationId, skipReason, skipValue, pctT30 }, 'Trade skipped');
  }

  /**
   * Backfill momentum comparison fields on closed trades.
   * Call periodically (e.g., every 5 minutes) from TradingEngine.
   */
  backfillMomentum(): void {
    const changes = backfillTradeMomentum(this.db);
    if (changes > 0) {
      logger.info({ changes }, 'Backfilled momentum data on closed trades');
    }
  }
}
