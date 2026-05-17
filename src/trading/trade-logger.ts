import Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';
import {
  insertTrade,
  closeTrade,
  markTradeFailed,
  insertTradeSkip,
  backfillTradeMomentum,
  updateTradeEntryFill,
} from '../db/queries';
import { TradingConfig, ExecutionMode } from './config';
import { FilterStageResult } from './filter-pipeline';

const logger = makeLogger('trade-logger');

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
  strategyId?: string;
  executionMode?: ExecutionMode;
}

export interface CloseTradeParams {
  tradeId: number;
  entryPriceSol: number;
  exitPriceSol: number;
  exitReason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'trailing_tp' | 'breakeven_stop' | 'timeout' | 'manual' | 'killswitch' | 'markov_exit';
  tradeSizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  slGapPenaltyPct: number;
  tpGapPenaltyPct: number;
  exitTxSignature?: string;
  /** When provided (live modes), replaces the assumed gap penalty with the
   *  actual slippage measured at fill time. */
  measuredExitSlippagePct?: number;
  /** Shadow-only: what the measured slippage would have been. Persists for
   *  paper-vs-shadow comparison; does NOT change net_return_pct arithmetic. */
  shadowMeasuredExitSlippagePct?: number;
  jitoTipSol?: number;
  txLandMs?: number;
  executionMode?: ExecutionMode;
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

    const executionMode = params.executionMode ?? 'paper';
    const tradeId = insertTrade(this.db, {
      graduation_id: params.graduationId,
      // Legacy `mode` column kept for back-compat — 'paper' for anything that
      // doesn't submit a tx, 'live' for live_micro/live_full. execution_mode
      // carries the full phase.
      mode: (executionMode === 'live_micro' || executionMode === 'live_full') ? 'live' : 'paper',
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
      strategy_id: params.strategyId,
      execution_mode: executionMode,
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

    // Cost model branches by execution mode:
    //   live_*  → real measured exit slippage applied to effective exit price.
    //             Round-trip cost still subtracted (entry-side LP fee + spread,
    //             plus jito tip / tx fee that liveBuy already accounted for in
    //             the wallet diff).
    //   shadow  → measured entry + exit slippage (no gap penalty, no roundTrip
    //             since the AMM math in shadowBuy/Sell already includes LP fee).
    //             Plus simulated jito tip + tx fee so net_return_pct matches what
    //             a live fill would actually net.
    //   paper   → static gap penalty + roundTripCostPct fallback (unchanged).
    //
    // Pull the row's stored entry-side metadata once so all three branches can
    // see entry slip, jito tip, trade size, and the measured round-trip cost.
    let entrySlippagePct: number | null = null;
    let shadowEntrySlipPct: number | null = null;
    let entryJitoTipSol: number | null = null;
    let measuredRoundTripPct: number | null = null;
    try {
      const row = this.db.prepare(
        `SELECT t.entry_slippage_pct,
                t.shadow_measured_entry_slippage_pct,
                t.jito_tip_sol AS entry_jito_tip_sol,
                gm.round_trip_slippage_pct
         FROM trades_v2 t
         LEFT JOIN graduation_momentum gm ON gm.graduation_id = t.graduation_id
         WHERE t.id = ?`
      ).get(params.tradeId) as any;
      if (row) {
        entrySlippagePct = row.entry_slippage_pct ?? null;
        shadowEntrySlipPct = row.shadow_measured_entry_slippage_pct ?? null;
        entryJitoTipSol = row.entry_jito_tip_sol ?? null;
        measuredRoundTripPct = row.round_trip_slippage_pct ?? null;
      }
    } catch { /* use defaults */ }

    let effectiveExitPrice = exitPriceSol;
    let netReturnPct: number;
    let estimatedFeesSol: number;

    const isLiveFill = params.measuredExitSlippagePct != null &&
      (params.executionMode === 'live_micro' || params.executionMode === 'live_full');
    const isShadow = params.executionMode === 'shadow';

    if (isShadow) {
      // Measured-cost model. shadow_measured_*_slippage_pct already includes
      // LP fee + spread + price impact at our trade size, so don't stack a
      // synthetic round-trip cost on top of it.
      const entrySlip = shadowEntrySlipPct ?? 0;
      const exitSlip = params.shadowMeasuredExitSlippagePct ?? 0;
      effectiveExitPrice = exitPriceSol * (1 - exitSlip / 100);
      // True post-slip return = gross - entry_slip - exit_slip (small-slip
      // approximation; exact compounding diverges by < 0.05 pp at < 5% slip).
      const slipAdjustedReturnPct = grossReturnPct - entrySlip - exitSlip;
      // Simulated execution overhead: jito tips (entry already on row, exit
      // arrives via params) + 2 × tx fee. tradeSizeSol denominates both.
      const totalJitoTipSol = (entryJitoTipSol ?? 0) + (params.jitoTipSol ?? 0);
      const txOverheadSol = (5_000 * 2) / 1e9; // 2 × TX_FEE_LAMPORTS
      const overheadSol = totalJitoTipSol + txOverheadSol;
      const overheadPct = params.tradeSizeSol > 0
        ? (overheadSol / params.tradeSizeSol) * 100
        : 0;
      netReturnPct = slipAdjustedReturnPct - overheadPct;
      estimatedFeesSol = overheadSol + params.tradeSizeSol * (entrySlip + exitSlip) / 100;
    } else if (isLiveFill) {
      effectiveExitPrice = exitPriceSol * (1 - (params.measuredExitSlippagePct as number) / 100);
      const gapAdjustedReturnPct = ((effectiveExitPrice - entryPriceSol) / entryPriceSol) * 100;
      const roundTripCostPct = measuredRoundTripPct ?? 1.75;
      estimatedFeesSol = params.tradeSizeSol * (roundTripCostPct / 100);
      netReturnPct = gapAdjustedReturnPct - roundTripCostPct;
    } else {
      // Paper — unchanged. Static gap penalty + measured/default round-trip cost.
      if (exitReason === 'stop_loss') {
        effectiveExitPrice = exitPriceSol * (1 - params.slGapPenaltyPct / 100);
      } else if (exitReason === 'trailing_stop' || exitReason === 'breakeven_stop') {
        const inProfit = exitPriceSol > entryPriceSol;
        const penaltyPct = inProfit ? params.tpGapPenaltyPct : params.slGapPenaltyPct;
        effectiveExitPrice = exitPriceSol * (1 - penaltyPct / 100);
      } else if (exitReason === 'take_profit' || exitReason === 'trailing_tp') {
        effectiveExitPrice = exitPriceSol * (1 - params.tpGapPenaltyPct / 100);
      }
      const gapAdjustedReturnPct = ((effectiveExitPrice - entryPriceSol) / entryPriceSol) * 100;
      const roundTripCostPct = measuredRoundTripPct ?? 1.75;
      estimatedFeesSol = params.tradeSizeSol * (roundTripCostPct / 100);
      netReturnPct = gapAdjustedReturnPct - roundTripCostPct;
    }

    const gapAdjustedReturnPct = ((effectiveExitPrice - entryPriceSol) / entryPriceSol) * 100;
    const netProfitSol = params.tradeSizeSol * (netReturnPct / 100);
    void entrySlippagePct; // captured for future use; not currently in net calc

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
      measured_exit_slippage_pct: isLiveFill ? params.measuredExitSlippagePct : undefined,
      shadow_measured_exit_slippage_pct: params.shadowMeasuredExitSlippagePct,
      jito_tip_sol: params.jitoTipSol,
      tx_land_ms: params.txLandMs,
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

  /** Mark a trade as failed (entry tx failed, etc.). Optional tx context is
   *  persisted so post-mortems have on-chain evidence even when the buy
   *  bailed before the success path could record it. */
  failTrade(
    tradeId: number,
    reason: string,
    extras?: { txSignature?: string; txLandMs?: number; jitoTipSol?: number },
  ): void {
    markTradeFailed(this.db, tradeId, reason, extras);
    logger.warn({ tradeId, reason, txSignature: extras?.txSignature }, 'Trade failed');
  }

  /**
   * Patch entry fields after the buy fills. Must be called between openTrade()
   * and addPosition() so restart-recovery and dashboard display see the real
   * fill price and token balance — not the pre-fill expected price.
   */
  recordEntryFill(
    tradeId: number,
    effectivePrice: number,
    tokensReceived: number,
    txSignature?: string,
    extras?: {
      shadowMeasuredEntrySlippagePct?: number;
      jitoTipSol?: number;
      txLandMs?: number;
    },
  ): void {
    updateTradeEntryFill(this.db, tradeId, {
      entry_effective_price: effectivePrice,
      entry_tokens_received: tokensReceived,
      entry_tx_signature: txSignature,
      shadow_measured_entry_slippage_pct: extras?.shadowMeasuredEntrySlippagePct,
      jito_tip_sol: extras?.jitoTipSol,
      tx_land_ms: extras?.txLandMs,
    });
    logger.debug(
      { tradeId, effectivePrice, tokensReceived, hasTx: !!txSignature },
      'Trade entry fill recorded'
    );
  }

  /** Log a graduation that was evaluated but not entered */
  logSkipped(
    graduationId: number,
    skipReason: string,
    skipValue: number | null,
    pctT30: number | null,
    strategyId: string = 'default',
  ): void {
    insertTradeSkip(this.db, graduationId, skipReason, skipValue, pctT30, strategyId);
    logger.debug({ graduationId, skipReason, skipValue, pctT30, strategy: strategyId }, 'Trade skipped');
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
