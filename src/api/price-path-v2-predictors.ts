/**
 * src/api/price-path-v2-predictors.ts
 *
 * Source-of-truth list of columns allowed as PREDICTORS on the /price-path-v2
 * feature investigator. Outcome-only fields (anything that exists only AFTER
 * the T+30 entry decision) MUST NOT appear here.
 *
 * Whitelist is hand-curated against schema.ts (columns 159-294) — do NOT
 * auto-derive from FILTER_CATALOG. FILTER_CATALOG groups by filter usability,
 * not time-window safety; some catalog filters wrap post-T+30 inputs that are
 * safe in that strategy context but NOT safe as a backward-looking predictor
 * here. Cross-check at code review.
 *
 * Coverage classes:
 *   `always`         populated on every complete row (full coverage)
 *   `auto-backfill`  backfilled at boot via idempotent bot_settings marker —
 *                    safe on historical rows
 *   `new-only`       permanent NULL on pre-rollout rows because raw inputs
 *                    weren't stored; Panel 2 surfaces winner_n_with_data so
 *                    the coverage gap is visible
 */

export type CoverageClass = 'always' | 'auto-backfill' | 'new-only';

export interface PredictorDef {
  col: string;
  display: string;
  units: string;
  coverage: CoverageClass;
  direction_hint?: 'higher_is_better' | 'lower_is_better' | 'unknown';
}

export const PREDICTOR_WHITELIST: PredictorDef[] = [
  // ── always populated (T+0 context + 5s checkpoints up to T+30) ──
  { col: 'holder_count',            display: 'Holder count @ T+0',          units: 'count',     coverage: 'always', direction_hint: 'higher_is_better' },
  { col: 'top5_wallet_pct',         display: 'Top-5 wallet %',              units: '%',         coverage: 'always', direction_hint: 'lower_is_better' },
  { col: 'dev_wallet_pct',          display: 'Dev wallet %',                units: '%',         coverage: 'always', direction_hint: 'lower_is_better' },
  { col: 'bc_velocity_sol_per_min', display: 'BC velocity',                 units: 'SOL/min',   coverage: 'always', direction_hint: 'unknown' },
  { col: 'token_age_seconds',       display: 'Token age @ graduation',      units: 's',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'total_sol_raised',        display: 'Total SOL raised (BC)',       units: 'SOL',       coverage: 'always', direction_hint: 'higher_is_better' },
  { col: 'pct_t5',                  display: '% return @ T+5',              units: '%',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'pct_t10',                 display: '% return @ T+10',             units: '%',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'pct_t15',                 display: '% return @ T+15',             units: '%',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'pct_t20',                 display: '% return @ T+20',             units: '%',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'pct_t25',                 display: '% return @ T+25',             units: '%',         coverage: 'always', direction_hint: 'unknown' },
  { col: 'pct_t30',                 display: '% return @ T+30',             units: '%',         coverage: 'always', direction_hint: 'unknown' },

  // ── auto-backfilled at boot (safe on historical) ──
  { col: 'sniper_count_t0_t2',          display: 'Sniper count T+0..T+2',           units: 'count',      coverage: 'auto-backfill', direction_hint: 'lower_is_better' },
  { col: 'sniper_sol_t0_t2',            display: 'Sniper SOL T+0..T+2',             units: 'SOL',        coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'sniper_wallet_velocity_avg',  display: 'Sniper wallet velocity (avg)',    units: 'count',      coverage: 'auto-backfill', direction_hint: 'lower_is_better' },
  { col: 'sniper_wallet_velocity_max',  display: 'Sniper wallet velocity (max)',    units: 'count',      coverage: 'auto-backfill', direction_hint: 'lower_is_better' },
  { col: 'firstbuyer_priors',           display: 'First-buyer priors',              units: 'count',      coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'flow_imbalance_t30',          display: 'Flow imbalance @ T+30',           units: 'ratio -1..1', coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'flow_sol_buys_0_30',          display: 'Flow SOL buys 0-30',              units: 'SOL',        coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'flow_sol_sells_0_30',         display: 'Flow SOL sells 0-30',             units: 'SOL',        coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'price_vs_vwap_t30_pct',       display: 'Price vs VWAP @ T+30',            units: '%',          coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'creator_prior_token_count',   display: 'Creator prior token count',       units: 'count',      coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'creator_prior_rug_rate',      display: 'Creator prior rug rate',          units: 'ratio 0-1',  coverage: 'auto-backfill', direction_hint: 'lower_is_better' },
  { col: 'creator_prior_avg_return',    display: 'Creator prior avg return',        units: '%',          coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'creator_last_token_age_hours', display: 'Creator last token age',         units: 'h',          coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'graduation_density_5min',     display: 'Graduation density (5min)',       units: 'count',      coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'batch_rank_within_5min',      display: 'Batch rank within 5min',          units: 'count',      coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'acceleration_t30',            display: 'Acceleration @ T+30',             units: 'pp',         coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'monotonicity_0_30',           display: 'Monotonicity 0-30',               units: 'ratio 0-1',  coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'path_smoothness_0_30',        display: 'Path smoothness 0-30 (SD)',       units: 'pp',         coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'max_drawdown_0_30',           display: 'Max drawdown 0-30',               units: '%',          coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'max_tick_drop_0_30',          display: 'Max tick drop 0-30',              units: 'pp',         coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'sum_abs_returns_0_30',        display: 'Sum |Δ| returns 0-30',            units: 'pp',         coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'early_vs_late_0_30',          display: 'Early vs late 0-30',              units: 'pp',         coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'dip_and_recover_flag',        display: 'Dip & recover (0/1)',             units: 'bool',       coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'recovery_t30_above_t15',      display: 'Recovery T+30 > T+15 (0/1)',      units: 'bool',       coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'volatility_0_30',             display: 'Volatility 0-30',                 units: '%',          coverage: 'auto-backfill', direction_hint: 'unknown' },
  { col: 'liquidity_sol_t30',           display: 'Liquidity @ T+30',                units: 'SOL',        coverage: 'auto-backfill', direction_hint: 'higher_is_better' },
  { col: 'slippage_est_05sol',          display: 'Slippage est 0.5 SOL @ T+30',     units: '%',          coverage: 'auto-backfill', direction_hint: 'lower_is_better' },

  // ── new-row-only (permanent NULL on pre-rollout rows) ──
  { col: 'top10_wallet_pct',            display: 'Top-10 wallet %',                 units: '%',          coverage: 'new-only', direction_hint: 'lower_is_better' },
  { col: 'wallet_gini_top20',           display: 'Wallet Gini (top-20)',            units: 'ratio 0-1',  coverage: 'new-only', direction_hint: 'unknown' },
  { col: 'pumpswap_initial_lp_sol',     display: 'Initial LP @ T+0',                units: 'SOL',        coverage: 'new-only', direction_hint: 'higher_is_better' },
  { col: 'pumpswap_initial_lp_tokens',  display: 'Initial LP tokens',               units: 'tokens',     coverage: 'new-only', direction_hint: 'unknown' },
  { col: 'pumpswap_lp_growth_t0_to_t30_pct', display: 'LP growth T+0 → T+30',       units: '%',          coverage: 'new-only', direction_hint: 'higher_is_better' },
  { col: 'buy_pressure_unique_buyers',  display: 'Buy pressure unique buyers',      units: 'count',      coverage: 'new-only', direction_hint: 'higher_is_better' },
  { col: 'buy_pressure_buy_ratio',      display: 'Buy ratio (buys / total)',        units: 'ratio 0-1',  coverage: 'new-only', direction_hint: 'higher_is_better' },
  { col: 'buy_pressure_whale_pct',      display: 'Whale share of buy SOL',          units: '%',          coverage: 'new-only', direction_hint: 'lower_is_better' },
  { col: 'buy_pressure_trade_count',    display: 'Buy pressure tx count',           units: 'count',      coverage: 'new-only', direction_hint: 'higher_is_better' },
];

/**
 * Curated bivariate pairs for Panel 4. First pair is mandatory: concentration
 * × velocity is the strongest combined signal in both the MemeTrans
 * literature and the GMGN terminal's surfaced metrics.
 */
export const BIVARIATE_PAIRS: Array<[string, string]> = [
  ['top10_wallet_pct',           'bc_velocity_sol_per_min'], // mandatory
  ['top5_wallet_pct',            'bc_velocity_sol_per_min'],
  ['flow_imbalance_t30',         'sniper_count_t0_t2'],
  ['monotonicity_0_30',          'max_drawdown_0_30'],
  ['holder_count',               'dev_wallet_pct'],
  ['creator_prior_rug_rate',     'sniper_wallet_velocity_avg'],
  ['buy_pressure_buy_ratio',     'buy_pressure_whale_pct'],
  ['liquidity_sol_t30',          'price_vs_vwap_t30_pct'],
];
