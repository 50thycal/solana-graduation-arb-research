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
    slGapPenaltyPct: parseFloat(process.env.SL_GAP_PENALTY_PCT || '20'),
    tpGapPenaltyPct: parseFloat(process.env.TP_GAP_PENALTY_PCT || '10'),
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
