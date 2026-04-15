import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-config');

export interface FilterConfig {
  /** Column name from graduation_momentum table */
  field: string;
  operator: '>=' | '<=' | '>' | '<' | '==' | '!=';
  value: number;
  /** Human-readable label shown in dashboard and trade log */
  label: string;
}

/**
 * Per-strategy parameters — the subset of TradingConfig that can be
 * edited from the dashboard and varies between parallel strategies.
 */
export interface StrategyParams {
  tradeSizeSol: number;
  maxConcurrentPositions: number;
  entryGateMinPctT30: number;
  entryGateMaxPctT30: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldSeconds: number;
  slGapPenaltyPct: number;
  tpGapPenaltyPct: number;
  filters: FilterConfig[];
  /**
   * Controls how often the position manager checks price for SL/TP.
   * five_second: independent 5s polling from position entry (more responsive, may catch intra-schedule moves)
   * match_collection: checks at the same SNAPSHOT_SCHEDULE offsets as the price collector
   *   (every 5s for T+0–T+60, then 30s/60s gaps) — results directly comparable to historical Panel 4 data
   */
  positionMonitorMode: 'five_second' | 'match_collection';

  // ── Dynamic position monitoring ──────────────────────────────────────
  /** Trailing SL: once price rises this % above entry, SL starts trailing.
   *  0 = disabled. e.g. 10 → activate after +10% from entry. */
  trailingSlActivationPct: number;
  /** Trailing SL trails this % below the highest price seen. e.g. 5 → 5% below peak. */
  trailingSlDistancePct: number;
  /** Ignore the hard SL for this many seconds after entry. 0 = disabled. */
  slActivationDelaySec: number;
  /** When true, hitting TP starts a trailing mechanism instead of exiting immediately. */
  trailingTpEnabled: boolean;
  /** Trailing TP: exit when price drops this % from post-TP peak. e.g. 5 → 5% drop. */
  trailingTpDropPct: number;
  /** Tighten SL at this % of maxHoldSeconds elapsed. 0 = disabled. e.g. 50. */
  tightenSlAtPctTime: number;
  /** Tighten SL to this % at stage 1. e.g. 7 → SL becomes 7%. */
  tightenSlTargetPct: number;
  /** Second tightening stage at this % of maxHoldSeconds. 0 = disabled. */
  tightenSlAtPctTime2: number;
  /** Tighten SL to this % at stage 2. e.g. 5 → SL becomes 5%. */
  tightenSlTargetPct2: number;
  /** Move SL to entry price once price reaches this % above entry. 0 = disabled. */
  breakevenStopPct: number;
}

export interface TradingConfig {
  /** Master switch — false = no evaluation, no DB writes */
  enabled: boolean;
  /** paper: simulate fills, no txs | live: execute via Jupiter */
  mode: 'paper' | 'live';

  // ── Position sizing ─────────────────────────────────────────────────────
  tradeSizeSol: number;
  /** Max simultaneous open positions. Start at 1 — RPC budget is tight. */
  maxConcurrentPositions: number;

  // ── Entry gate (checked before filter pipeline) ─────────────────────────
  /** Min pct_t30 required to enter (e.g. 5 = +5% from open) */
  entryGateMinPctT30: number;
  /** Max pct_t30 allowed (e.g. 100 = +100% from open) */
  entryGateMaxPctT30: number;

  // ── Exit parameters ──────────────────────────────────────────────────────
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldSeconds: number;

  // ── Gap penalties (must match Panel 4 methodology for valid comparison) ──
  /** Applied to SL exits: effective exit = price * (1 - slGapPenaltyPct/100) */
  slGapPenaltyPct: number;
  /** Applied to TP exits: effective exit = price * (1 - tpGapPenaltyPct/100) */
  tpGapPenaltyPct: number;

  // ── Position monitor mode ────────────────────────────────────────────────
  positionMonitorMode: 'five_second' | 'match_collection';

  // ── Dynamic position monitoring ──────────────────────────────────────────
  trailingSlActivationPct: number;
  trailingSlDistancePct: number;
  slActivationDelaySec: number;
  trailingTpEnabled: boolean;
  trailingTpDropPct: number;
  tightenSlAtPctTime: number;
  tightenSlTargetPct: number;
  tightenSlAtPctTime2: number;
  tightenSlTargetPct2: number;
  breakevenStopPct: number;

  // ── Execution (live mode only) ───────────────────────────────────────────
  slippageBps: number;
  priorityFeeMicroLamports: number;
  /** base58 private key — loaded from env, never logged */
  walletPrivateKey?: string;

  // ── Filter pipeline ──────────────────────────────────────────────────────
  /** All filters must pass (AND logic) before entry is triggered */
  filters: FilterConfig[];
}

/** Default filter preset: vel 5-20 sol/min — the primary confirmed signal */
const DEFAULT_FILTERS: FilterConfig[] = [
  { field: 'bc_velocity_sol_per_min', operator: '>=', value: 5,  label: 'vel>=5' },
  { field: 'bc_velocity_sol_per_min', operator: '<',  value: 20, label: 'vel<20' },
];

export function loadTradingConfig(): TradingConfig {
  let filters: FilterConfig[] = DEFAULT_FILTERS;
  if (process.env.TRADING_FILTERS) {
    try {
      filters = JSON.parse(process.env.TRADING_FILTERS);
    } catch (e) {
      logger.error('Failed to parse TRADING_FILTERS env var — using default vel 5-20 preset');
    }
  }

  const cfg: TradingConfig = {
    enabled: process.env.TRADING_ENABLED === 'true',
    mode: (process.env.TRADING_MODE as 'paper' | 'live') === 'live' ? 'live' : 'paper',
    tradeSizeSol: parseFloat(process.env.TRADE_SIZE_SOL || '0.5'),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '1', 10),
    entryGateMinPctT30: parseFloat(process.env.ENTRY_GATE_MIN_PCT || '5'),
    entryGateMaxPctT30: parseFloat(process.env.ENTRY_GATE_MAX_PCT || '100'),
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '30'),
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '10'),
    maxHoldSeconds: parseInt(process.env.MAX_HOLD_SECONDS || '300', 10),
    slGapPenaltyPct: parseFloat(process.env.SL_GAP_PENALTY_PCT || '30'),
    tpGapPenaltyPct: parseFloat(process.env.TP_GAP_PENALTY_PCT || '10'),
    positionMonitorMode: (process.env.POSITION_MONITOR_MODE === 'match_collection' ? 'match_collection' : 'five_second'),
    trailingSlActivationPct: parseFloat(process.env.TRAILING_SL_ACTIVATION_PCT || '0'),
    trailingSlDistancePct: parseFloat(process.env.TRAILING_SL_DISTANCE_PCT || '5'),
    slActivationDelaySec: parseInt(process.env.SL_ACTIVATION_DELAY_SEC || '0', 10),
    trailingTpEnabled: process.env.TRAILING_TP_ENABLED === 'true',
    trailingTpDropPct: parseFloat(process.env.TRAILING_TP_DROP_PCT || '5'),
    tightenSlAtPctTime: parseFloat(process.env.TIGHTEN_SL_AT_PCT_TIME || '0'),
    tightenSlTargetPct: parseFloat(process.env.TIGHTEN_SL_TARGET_PCT || '7'),
    tightenSlAtPctTime2: parseFloat(process.env.TIGHTEN_SL_AT_PCT_TIME2 || '0'),
    tightenSlTargetPct2: parseFloat(process.env.TIGHTEN_SL_TARGET_PCT2 || '5'),
    breakevenStopPct: parseFloat(process.env.BREAKEVEN_STOP_PCT || '0'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '300', 10),
    priorityFeeMicroLamports: parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '100000', 10),
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    filters,
  };

  if (cfg.mode === 'live' && !cfg.walletPrivateKey) {
    throw new Error('TRADING_MODE=live requires WALLET_PRIVATE_KEY to be set');
  }

  return cfg;
}

export function describeTradingConfig(cfg: TradingConfig): string {
  const filterLabels = cfg.filters.map(f => f.label).join(' AND ');
  return [
    `mode=${cfg.mode}`,
    `size=${cfg.tradeSizeSol}SOL`,
    `TP=${cfg.takeProfitPct}%`,
    `SL=${cfg.stopLossPct}%`,
    `maxHold=${cfg.maxHoldSeconds}s`,
    `gate=[+${cfg.entryGateMinPctT30}%..+${cfg.entryGateMaxPctT30}%]`,
    `filters=[${filterLabels || 'none'}]`,
  ].join(' ');
}

/** Extract the per-strategy subset from a full TradingConfig */
export function strategyParamsFromConfig(cfg: TradingConfig): StrategyParams {
  return {
    tradeSizeSol: cfg.tradeSizeSol,
    maxConcurrentPositions: cfg.maxConcurrentPositions,
    entryGateMinPctT30: cfg.entryGateMinPctT30,
    entryGateMaxPctT30: cfg.entryGateMaxPctT30,
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct: cfg.stopLossPct,
    maxHoldSeconds: cfg.maxHoldSeconds,
    slGapPenaltyPct: cfg.slGapPenaltyPct,
    tpGapPenaltyPct: cfg.tpGapPenaltyPct,
    filters: cfg.filters,
    positionMonitorMode: cfg.positionMonitorMode ?? 'five_second',
    trailingSlActivationPct: cfg.trailingSlActivationPct ?? 0,
    trailingSlDistancePct: cfg.trailingSlDistancePct ?? 5,
    slActivationDelaySec: cfg.slActivationDelaySec ?? 0,
    trailingTpEnabled: cfg.trailingTpEnabled ?? false,
    trailingTpDropPct: cfg.trailingTpDropPct ?? 5,
    tightenSlAtPctTime: cfg.tightenSlAtPctTime ?? 0,
    tightenSlTargetPct: cfg.tightenSlTargetPct ?? 7,
    tightenSlAtPctTime2: cfg.tightenSlAtPctTime2 ?? 0,
    tightenSlTargetPct2: cfg.tightenSlTargetPct2 ?? 5,
    breakevenStopPct: cfg.breakevenStopPct ?? 0,
  };
}

/** Merge per-strategy params with global settings to produce a full TradingConfig */
export function mergeStrategyParams(globalCfg: TradingConfig, params: StrategyParams): TradingConfig {
  return {
    ...globalCfg,
    tradeSizeSol: params.tradeSizeSol,
    maxConcurrentPositions: params.maxConcurrentPositions,
    entryGateMinPctT30: params.entryGateMinPctT30,
    entryGateMaxPctT30: params.entryGateMaxPctT30,
    takeProfitPct: params.takeProfitPct,
    stopLossPct: params.stopLossPct,
    maxHoldSeconds: params.maxHoldSeconds,
    slGapPenaltyPct: params.slGapPenaltyPct,
    tpGapPenaltyPct: params.tpGapPenaltyPct,
    filters: params.filters,
    positionMonitorMode: params.positionMonitorMode ?? 'five_second',
    trailingSlActivationPct: params.trailingSlActivationPct ?? 0,
    trailingSlDistancePct: params.trailingSlDistancePct ?? 5,
    slActivationDelaySec: params.slActivationDelaySec ?? 0,
    trailingTpEnabled: params.trailingTpEnabled ?? false,
    trailingTpDropPct: params.trailingTpDropPct ?? 5,
    tightenSlAtPctTime: params.tightenSlAtPctTime ?? 0,
    tightenSlTargetPct: params.tightenSlTargetPct ?? 7,
    tightenSlAtPctTime2: params.tightenSlAtPctTime2 ?? 0,
    tightenSlTargetPct2: params.tightenSlTargetPct2 ?? 5,
    breakevenStopPct: params.breakevenStopPct ?? 0,
  };
}
