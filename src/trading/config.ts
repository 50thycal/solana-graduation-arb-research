import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-config');

/**
 * Phased rollout for a strategy.
 *   paper      — simulate fills with gap penalties (no chain interaction)
 *   shadow     — read pool state at entry/exit, record what the fill WOULD have been
 *                (measured slippage), but never submit a tx. Still persists as a
 *                trade row with execution_mode='shadow' for comparison to paper.
 *   live_micro — submit real txs at MICRO_TRADE_SIZE_SOL (hard override)
 *   live_full  — submit real txs at the strategy's configured tradeSizeSol
 */
export type ExecutionMode = 'paper' | 'shadow' | 'live_micro' | 'live_full';

// ── Live execution constants (shared by executor, safety, jito) ──────────────
/** Hard cap on live trading losses per UTC day. Circuit breaker trips at ≤ -DAILY_MAX_LOSS_SOL. */
export const DAILY_MAX_LOSS_SOL = parseFloat(process.env.DAILY_MAX_LOSS_SOL || '1.0');
/** Position size used in the live_micro rollout phase — overrides strategy's tradeSizeSol. */
export const MICRO_TRADE_SIZE_SOL = parseFloat(process.env.MICRO_TRADE_SIZE_SOL || '0.05');
/** Default Jito tip when a strategy doesn't specify one. Raised 2026-05-30
 *  from 0.0001 to 0.0005 SOL (500k lamports) so live txs win Jito bundle
 *  inclusion (~1s) instead of falling back to the slow ~5s RPC path that was
 *  driving the live-vs-shadow drift. Overridable via DEFAULT_JITO_TIP_SOL env;
 *  retry escalation still multiplies this (tipMult). */
export const DEFAULT_JITO_TIP_SOL = parseFloat(process.env.DEFAULT_JITO_TIP_SOL || '0.0005');
/** Copy-trade-specific Jito tip (SOL). Copy buys/sells are sniper-competitive — the
 *  global 0.0005 default loses every bundle auction (telemetry: 100% RPC fallback at
 *  ~4.7s median on copy-hotlead-hold30m, while STILL paying the tip), so copy tips a
 *  higher amount WITHOUT raising the main strategies' (v44/v50, T+30 entry) tips.
 *  Applied as a base multiplier over DEFAULT_JITO_TIP_SOL; the per-attempt retry
 *  escalation still multiplies on top. env-tunable — tune down to the minimum that
 *  lands once telemetry shows `jito` entries appearing. */
export const COPY_JITO_TIP_SOL = parseFloat(process.env.COPY_JITO_TIP_SOL || '0.003');
/** Max acceptable expected slippage at entry. 500 = 5%. */
export const DEFAULT_MAX_SLIPPAGE_BPS = parseInt(process.env.DEFAULT_MAX_SLIPPAGE_BPS || '500', 10);
/**
 * Quote-side slippage tolerance on the actual swap ix (basis points).
 * 500 = 5%. Distinct from DEFAULT_MAX_SLIPPAGE_BPS (entry preflight gate).
 * On buy: maxQuoteAmountIn = solIn * (10000 + bps) / 10000
 * On sell: minQuoteOut = expectedSolOut * (10000 - bps) / 10000
 *
 * 2026-05-22: bumped to 10% to absorb pool fee + protocol fee + price
 * impact on volatile graduations, fixing Custom 6004 (ExceededSlippage)
 * crashes and stuck-position sell retries on grad 23066.
 *
 * 2026-05-23: reverted to 5%. The wider tolerance let SL exits land at
 * -33% to -48% (vs configured 30%), turning prevented stuck-positions
 * into much larger realized losses (-0.16 SOL drawdown on v25-bot-excl-
 * climbing-live-micro in a 4h window). 5% rejects bad fills and forces
 * a retry — stuck positions are recoverable, bad fills are not. The
 * underlying v25 misconfiguration (filters=[] in live_micro vs 5 filters
 * in shadow) was the real cause of the SL hits; once filters are
 * restored, 5% buffer is the right default again.
 */
export const SWAP_SLIPPAGE_BPS = parseInt(process.env.SWAP_SLIPPAGE_BPS || '500', 10);
/** SOL kept as buffer above tradeSize for tx fees + ATA rent. */
export const WALLET_SOL_BUFFER = parseFloat(process.env.WALLET_SOL_BUFFER || '0.02');
/** Regional Jito block engine endpoint. Frankfurt/NY/Amsterdam/Tokyo also available. */
export const JITO_BLOCK_ENGINE_URL =
  process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf';
/** File path — presence trips the killswitch. Checked on every safety cycle. */
export const KILLSWITCH_FILE = process.env.TRADING_KILLSWITCH_FILE || '.trading-kill';

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
   * Seconds after graduation at which to evaluate + enter. Default 30 (T+30,
   * the historical baseline). Allowed values must match a `price_t<sec>` column
   * on graduation_momentum: {30, 60, 90, 120, 180, 240, 300}. Late-entry
   * strategies fan out at T+entryTimingSec wall-clock and gate on
   * pct_t<entryTimingSec>. Mirrors `entryTimeMatrix` simulator semantics.
   */
  entryTimingSec?: number;
  /**
   * Controls how often the position manager checks price for SL/TP.
   * five_second: independent 5s polling from position entry (more responsive, may catch intra-schedule moves)
   * match_collection: checks at the same SNAPSHOT_SCHEDULE offsets as the price collector
   *   (every 5s for T+0–T+60, then 30s/60s gaps) — results directly comparable to historical Panel 4 data
   */
  positionMonitorMode: 'five_second' | 'match_collection';

  /** Position-poll cadence in seconds when positionMonitorMode='five_second'.
   *  Default 10 (2026-06-11 RPC budget cut — the T+30 shadow book is research
   *  only; copy-trade collection is the priority consumer. Coarser polling
   *  worsens exit discretization vs the historical 5s default — note when
   *  comparing pre/post-06-11 shadow stats. Restore via POLL_INTERVAL_SEC=5
   *  once the Helius plan resets). Tighter polling (1s) catches fast SL/TP
   *  transitions sooner. Capped at [1, 30]. Each strategy gets its own
   *  PositionManager so the per-strategy poll interval is independent. RPC
   *  cost scales linearly with 1/pollIntervalSec. Added 2026-05-19 (v28). */
  pollIntervalSec: number;

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
  /** Trailing TP only activates once the post-entry peak has cleared
   *  TP × (1 + minPeakLiftPct/100). 0 (default) preserves legacy behavior
   *  (trail from any TP touch). When > 0, near-miss trades that touch TP but
   *  don't clear the min-lift threshold exit at static TP if price retraces
   *  below TP — eliminates the "barely touched TP then dropped 10%" failure
   *  mode that hurt the v26 trailing-TP cohort. Added 2026-05-21 for v34. */
  trailingTpMinPeakLiftPct: number;
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

  // ── Markov state-conditional exit (optional DPM layer) ──────────────────
  /** Enable the Markov early-exit / late-hold logic. Default false.
   *  When true, the position-manager queries a precomputed transition matrix
   *  every 5s and may exit early or skip a fixed-TP exit based on the cell. */
  markovExitEnabled?: boolean;
  /** Exit threshold: if P(profit at T+300 | current state) < this, exit early.
   *  Default 0.30. Only fires when the matrix cell has >= MIN_CELL_N samples. */
  markovExitProbThreshold?: number;
  /** Hold threshold: if P(profit) > this AND price is already in the win zone,
   *  skip the fixed-TP exit and let the trailing-SL trail. Default 0.85. */
  markovHoldProbThreshold?: number;

  // ── Live execution (phase + per-strategy knobs) ───────────────────────
  /** Phased rollout — default 'paper'. Promote via strategy-commands.json. */
  executionMode?: ExecutionMode;
  /** Jito priority tip in SOL. Undefined = DEFAULT_JITO_TIP_SOL. */
  jitoTipSol?: number;
  /** Reject entry if expected slippage > this (bps). Undefined = DEFAULT_MAX_SLIPPAGE_BPS. */
  maxSlippageBps?: number;

  // ── Time-of-day gate (optional, UTC) ──────────────────────────────────
  /** Inclusive start of allowed UTC entry hour (0-23). If min > max, the
   *  window wraps around midnight (e.g. min=22, max=6 → 22,23,0..6 allowed).
   *  Both min and max must be set together; if either is undefined the gate
   *  is disabled. */
  entryHourUtcMin?: number;
  /** Inclusive end of allowed UTC entry hour (0-23). See entryHourUtcMin. */
  entryHourUtcMax?: number;

  // ── Market-regime gate (optional, uses market_daily) ─────────────────
  // All three filters are independent. If set, the trade's entry UTC date
  // must match the strategy's filter for entry to proceed. When the
  // market_daily row for the entry date is missing (e.g. CoinGecko fetch
  // lag), the gate is permissive (allows trade + logs a warning) to avoid
  // blackholing trades during transient fetcher outages.
  //
  // SOL daily return = (sol_usd_close - sol_usd_open) / sol_usd_open * 100.
  // Same formula for BTC. Fear & Greed value is the raw 0-100 index.
  /** Min SOL daily return % for entry (inclusive). E.g. -1.0 = only trade
   *  when SOL is down less than 1% or up. */
  entrySolReturnPctMin?: number;
  /** Max SOL daily return % for entry (inclusive). */
  entrySolReturnPctMax?: number;
  /** Min BTC daily return % for entry. */
  entryBtcReturnPctMin?: number;
  /** Max BTC daily return % for entry. */
  entryBtcReturnPctMax?: number;
  /** Min Fear & Greed value 0-100 (inclusive). 45 = Neutral+. */
  entryFngValueMin?: number;
  /** Max Fear & Greed value 0-100 (inclusive). */
  entryFngValueMax?: number;

  // ── Regime gate (optional, uses regime-analysis current.regime) ──────────
  // Skips entries based on the universe-level regime classifier computed from
  // pump_rate + fast_rug_rate over the last 50 graduations (see
  // src/api/regime-analysis.ts). Independent of the calendar-based market
  // gates above. Permissive on fresh-bot state (zero grads cached) to avoid
  // blackholing entries during startup.
  //
  //   'any'        — default; no regime check
  //   'skip_red'   — block entries when current regime is RED
  //   'green_only' — allow entries only when current regime is GREEN
  regimeGate?: 'any' | 'skip_red' | 'green_only';

  // ── Edge-decay signal gate (optional, paired signal/executor model) ──────
  // Reads the rolling per-strategy edge-decay flag (STRENGTHENING / STABLE /
  // DECAYING / LOW-N) computed from CLOSED trades in src/api/edge-decay.ts and
  // gates entry on it. Unlike regimeGate (a universe-level tape signal), this is
  // a *per-strategy performance* signal — "is this exact filter set hot or cold
  // right now".
  //
  // DEADLOCK NOTE: a strategy that stops trading freezes its OWN flag (no new
  // closed trades → the recent-30 window never rolls). So the signal is normally
  // sourced from a SEPARATE always-on "baseline" strategy via
  // edgeDecaySignalStrategyId, while the gated executor turns on/off. Leave the
  // baseline itself at edgeDecayGate:'any' so it never stops. Only self-gate
  // (edgeDecaySignalStrategyId unset) on a strategy you're willing to re-enable
  // by hand.
  //
  //   'any'           — default; no edge-decay check
  //   'skip_decaying' — enter while the signal is STRENGTHENING or STABLE; block DECAYING
  //   'strength_only' — enter only while the signal is STRENGTHENING
  //
  // Warmup is STRICT: a LOW-N signal (source has < 25 closed trades) or a
  // missing signal row blocks entry for BOTH modes — wait for a real
  // STRENGTHENING signal before committing.
  edgeDecayGate?: 'any' | 'skip_decaying' | 'strength_only';
  /** strategy_id whose edge-decay flag drives edgeDecayGate. Unset = self
   *  (deadlock-prone; only for the always-on baseline left at 'any'). */
  edgeDecaySignalStrategyId?: string;
  /** execution_mode bucket of the signal source — edge-decay rows are keyed by
   *  (strategy_id, execution_mode). Default 'shadow' (the baseline runs shadow).
   *  Falls back to the source's highest-n row if no exact mode match. */
  edgeDecaySignalExecutionMode?: string;
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
  pollIntervalSec: number;

  // ── Dynamic position monitoring ──────────────────────────────────────────
  trailingSlActivationPct: number;
  trailingSlDistancePct: number;
  slActivationDelaySec: number;
  trailingTpEnabled: boolean;
  trailingTpDropPct: number;
  trailingTpMinPeakLiftPct: number;
  tightenSlAtPctTime: number;
  tightenSlTargetPct: number;
  tightenSlAtPctTime2: number;
  tightenSlTargetPct2: number;
  breakevenStopPct: number;

  // ── Markov state-conditional exit ────────────────────────────────────────
  markovExitEnabled?: boolean;
  markovExitProbThreshold?: number;
  markovHoldProbThreshold?: number;

  // ── Execution (live mode only) ───────────────────────────────────────────
  slippageBps: number;
  priorityFeeMicroLamports: number;
  /** base58 private key — loaded from env, never logged */
  walletPrivateKey?: string;

  // ── Live execution (global defaults — overridden per-strategy) ──────────
  executionMode: ExecutionMode;
  jitoTipSol: number;
  maxSlippageBps: number;

  // ── Filter pipeline ──────────────────────────────────────────────────────
  /** All filters must pass (AND logic) before entry is triggered */
  filters: FilterConfig[];

  // ── Late entry (per-strategy override of T+30 default) ──────────────────
  /** Wall-clock seconds after graduation at which to enter. Default 30. */
  entryTimingSec?: number;

  // ── Time-of-day gate (UTC, optional) ────────────────────────────────────
  entryHourUtcMin?: number;
  entryHourUtcMax?: number;

  // ── Market-regime gate (optional) ───────────────────────────────────────
  entrySolReturnPctMin?: number;
  entrySolReturnPctMax?: number;
  entryBtcReturnPctMin?: number;
  entryBtcReturnPctMax?: number;
  entryFngValueMin?: number;
  entryFngValueMax?: number;
  regimeGate?: 'any' | 'skip_red' | 'green_only';
  edgeDecayGate?: 'any' | 'skip_decaying' | 'strength_only';
  edgeDecaySignalStrategyId?: string;
  edgeDecaySignalExecutionMode?: string;
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
    entryGateMinPctT30: parseFloat(process.env.ENTRY_GATE_MIN_PCT || '-99'),
    entryGateMaxPctT30: parseFloat(process.env.ENTRY_GATE_MAX_PCT || '1000'),
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '30'),
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '10'),
    maxHoldSeconds: parseInt(process.env.MAX_HOLD_SECONDS || '300', 10),
    slGapPenaltyPct: parseFloat(process.env.SL_GAP_PENALTY_PCT || '30'),
    tpGapPenaltyPct: parseFloat(process.env.TP_GAP_PENALTY_PCT || '10'),
    positionMonitorMode: (process.env.POSITION_MONITOR_MODE === 'match_collection' ? 'match_collection' : 'five_second'),
    pollIntervalSec: Math.max(1, Math.min(30, parseInt(process.env.POLL_INTERVAL_SEC || '10', 10))),
    trailingSlActivationPct: parseFloat(process.env.TRAILING_SL_ACTIVATION_PCT || '0'),
    trailingSlDistancePct: parseFloat(process.env.TRAILING_SL_DISTANCE_PCT || '5'),
    slActivationDelaySec: parseInt(process.env.SL_ACTIVATION_DELAY_SEC || '0', 10),
    trailingTpEnabled: process.env.TRAILING_TP_ENABLED === 'true',
    trailingTpDropPct: parseFloat(process.env.TRAILING_TP_DROP_PCT || '5'),
    trailingTpMinPeakLiftPct: parseFloat(process.env.TRAILING_TP_MIN_PEAK_LIFT_PCT || '0'),
    tightenSlAtPctTime: parseFloat(process.env.TIGHTEN_SL_AT_PCT_TIME || '0'),
    tightenSlTargetPct: parseFloat(process.env.TIGHTEN_SL_TARGET_PCT || '7'),
    tightenSlAtPctTime2: parseFloat(process.env.TIGHTEN_SL_AT_PCT_TIME2 || '0'),
    tightenSlTargetPct2: parseFloat(process.env.TIGHTEN_SL_TARGET_PCT2 || '5'),
    breakevenStopPct: parseFloat(process.env.BREAKEVEN_STOP_PCT || '0'),
    markovExitEnabled: process.env.MARKOV_EXIT_ENABLED === 'true',
    markovExitProbThreshold: parseFloat(process.env.MARKOV_EXIT_PROB_THRESHOLD || '0.30'),
    markovHoldProbThreshold: parseFloat(process.env.MARKOV_HOLD_PROB_THRESHOLD || '0.85'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '300', 10),
    priorityFeeMicroLamports: parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '100000', 10),
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    executionMode: ((process.env.EXECUTION_MODE as ExecutionMode) || 'paper'),
    jitoTipSol: parseFloat(process.env.JITO_TIP_SOL || String(DEFAULT_JITO_TIP_SOL)),
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || String(DEFAULT_MAX_SLIPPAGE_BPS), 10),
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
    cfg.regimeGate && cfg.regimeGate !== 'any' ? `regimeGate=${cfg.regimeGate}` : null,
    `filters=[${filterLabels || 'none'}]`,
  ].filter(Boolean).join(' ');
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
    entryTimingSec: cfg.entryTimingSec ?? 30,
    positionMonitorMode: cfg.positionMonitorMode ?? 'five_second',
    pollIntervalSec: Math.max(1, Math.min(30, cfg.pollIntervalSec ?? 10)),
    trailingSlActivationPct: cfg.trailingSlActivationPct ?? 0,
    trailingSlDistancePct: cfg.trailingSlDistancePct ?? 5,
    slActivationDelaySec: cfg.slActivationDelaySec ?? 0,
    trailingTpEnabled: cfg.trailingTpEnabled ?? false,
    trailingTpDropPct: cfg.trailingTpDropPct ?? 5,
    trailingTpMinPeakLiftPct: cfg.trailingTpMinPeakLiftPct ?? 0,
    tightenSlAtPctTime: cfg.tightenSlAtPctTime ?? 0,
    tightenSlTargetPct: cfg.tightenSlTargetPct ?? 7,
    tightenSlAtPctTime2: cfg.tightenSlAtPctTime2 ?? 0,
    tightenSlTargetPct2: cfg.tightenSlTargetPct2 ?? 5,
    breakevenStopPct: cfg.breakevenStopPct ?? 0,
    markovExitEnabled: cfg.markovExitEnabled ?? false,
    markovExitProbThreshold: cfg.markovExitProbThreshold ?? 0.30,
    markovHoldProbThreshold: cfg.markovHoldProbThreshold ?? 0.85,
    executionMode: cfg.executionMode ?? 'paper',
    jitoTipSol: cfg.jitoTipSol ?? DEFAULT_JITO_TIP_SOL,
    maxSlippageBps: cfg.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
    entryHourUtcMin: cfg.entryHourUtcMin,
    entryHourUtcMax: cfg.entryHourUtcMax,
    entrySolReturnPctMin: cfg.entrySolReturnPctMin,
    entrySolReturnPctMax: cfg.entrySolReturnPctMax,
    entryBtcReturnPctMin: cfg.entryBtcReturnPctMin,
    entryBtcReturnPctMax: cfg.entryBtcReturnPctMax,
    entryFngValueMin: cfg.entryFngValueMin,
    entryFngValueMax: cfg.entryFngValueMax,
    regimeGate: cfg.regimeGate ?? 'any',
    edgeDecayGate: cfg.edgeDecayGate ?? 'any',
    edgeDecaySignalStrategyId: cfg.edgeDecaySignalStrategyId,
    edgeDecaySignalExecutionMode: cfg.edgeDecaySignalExecutionMode,
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
    entryTimingSec: params.entryTimingSec ?? 30,
    positionMonitorMode: params.positionMonitorMode ?? 'five_second',
    pollIntervalSec: Math.max(1, Math.min(30, params.pollIntervalSec ?? globalCfg.pollIntervalSec ?? 10)),
    trailingSlActivationPct: params.trailingSlActivationPct ?? 0,
    trailingSlDistancePct: params.trailingSlDistancePct ?? 5,
    slActivationDelaySec: params.slActivationDelaySec ?? 0,
    trailingTpEnabled: params.trailingTpEnabled ?? false,
    trailingTpDropPct: params.trailingTpDropPct ?? 5,
    trailingTpMinPeakLiftPct: params.trailingTpMinPeakLiftPct ?? globalCfg.trailingTpMinPeakLiftPct ?? 0,
    tightenSlAtPctTime: params.tightenSlAtPctTime ?? 0,
    tightenSlTargetPct: params.tightenSlTargetPct ?? 7,
    tightenSlAtPctTime2: params.tightenSlAtPctTime2 ?? 0,
    tightenSlTargetPct2: params.tightenSlTargetPct2 ?? 5,
    breakevenStopPct: params.breakevenStopPct ?? 0,
    markovExitEnabled: params.markovExitEnabled ?? false,
    markovExitProbThreshold: params.markovExitProbThreshold ?? 0.30,
    markovHoldProbThreshold: params.markovHoldProbThreshold ?? 0.85,
    executionMode: params.executionMode ?? globalCfg.executionMode ?? 'paper',
    jitoTipSol: params.jitoTipSol ?? globalCfg.jitoTipSol ?? DEFAULT_JITO_TIP_SOL,
    maxSlippageBps: params.maxSlippageBps ?? globalCfg.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
    entryHourUtcMin: params.entryHourUtcMin ?? globalCfg.entryHourUtcMin,
    entryHourUtcMax: params.entryHourUtcMax ?? globalCfg.entryHourUtcMax,
    entrySolReturnPctMin: params.entrySolReturnPctMin ?? globalCfg.entrySolReturnPctMin,
    entrySolReturnPctMax: params.entrySolReturnPctMax ?? globalCfg.entrySolReturnPctMax,
    entryBtcReturnPctMin: params.entryBtcReturnPctMin ?? globalCfg.entryBtcReturnPctMin,
    entryBtcReturnPctMax: params.entryBtcReturnPctMax ?? globalCfg.entryBtcReturnPctMax,
    entryFngValueMin: params.entryFngValueMin ?? globalCfg.entryFngValueMin,
    entryFngValueMax: params.entryFngValueMax ?? globalCfg.entryFngValueMax,
    regimeGate: params.regimeGate ?? globalCfg.regimeGate ?? 'any',
    edgeDecayGate: params.edgeDecayGate ?? globalCfg.edgeDecayGate ?? 'any',
    edgeDecaySignalStrategyId: params.edgeDecaySignalStrategyId ?? globalCfg.edgeDecaySignalStrategyId,
    edgeDecaySignalExecutionMode: params.edgeDecaySignalExecutionMode ?? globalCfg.edgeDecaySignalExecutionMode,
  };
}

/** Returns true if `hour` (0-23 UTC) falls within the inclusive [min, max]
 *  window. Wraps around midnight when min > max (e.g. min=22, max=6 → allowed
 *  hours are 22,23,0,1,2,3,4,5,6). When either bound is undefined, returns
 *  true (gate is disabled). Caller is responsible for clamping inputs to 0-23. */
export function isHourInUtcWindow(
  hour: number,
  min: number | undefined,
  max: number | undefined,
): boolean {
  if (min == null || max == null) return true;
  const m = Math.max(0, Math.min(23, Math.floor(min)));
  const x = Math.max(0, Math.min(23, Math.floor(max)));
  if (m <= x) return hour >= m && hour <= x;
  // Wraps midnight: allowed = [m..23] ∪ [0..x]
  return hour >= m || hour <= x;
}
