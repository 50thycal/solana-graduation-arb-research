/**
 * src/api/aggregates.ts
 *
 * Shared computations used by the /api/* JSON endpoints. Built as standalone
 * reads against graduation_momentum + graduations + trades_v2 so the dashboard
 * HTML handlers in src/index.ts can keep working untouched during the initial
 * roll-out of the self-service API.
 *
 * Functions here should be pure: take a Database, return a plain object.
 * No console output, no side effects, no throwing — return null fields instead.
 *
 * Filter catalog mirrors PANEL_1_FILTERS at src/index.ts:1907. Kept as a
 * separate copy (not imported) because the index.ts handler defines them
 * inside the route closure. If that handler is refactored in the future,
 * move the catalog here and import it from both sides.
 */

import Database from 'better-sqlite3';

import {
  SIM_CHECKPOINT_COLUMNS,
  SIM_DEFAULT_COST_PCT,
  SIM_MIN_N_FOR_OPTIMUM,
  SIM_MIN_TP_HITS_FOR_OPTIMUM,
  SIM_SL_GAP_PENALTY,
  SIM_SL_GRID,
  SIM_TP_GAP_PENALTY,
  SIM_TP_GRID,
} from './sim-constants';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface ThesisScorecard {
  total_labeled: number;
  PUMP: number;
  DUMP: number;
  STABLE: number;
  unlabeled: number;
  raw_win_rate_pct: number | null;
  vel_5_20_cohort: {
    n: number;
    win_rate_pct: number | null;
    avg_return_t30_to_t300_pct: number | null;
    progress_to_200: string;
  };
  best_known_baseline: {
    filter: string;
    /** Per-combo optimal stop-loss (% from entry) — null if insufficient data. */
    opt_sl_pct: number | null;
    /** Per-combo optimal take-profit (% from entry) — null if insufficient data. */
    opt_tp_pct: number | null;
    /** Avg cost-adjusted return at the combo's optimum (tp, sl) cell. */
    avg_return_pct: number;
    n: number;
    note: string;
  };
}

export interface DataQualityFlags {
  price_source_pumpswap_all_last_10: boolean;
  null_fields_in_last_10: string[];
  last_graduation_seconds_ago: number | null;
  stalled: boolean;
  timestamp_drift_detected: boolean;
  /** Rows where every pct_t5..pct_t300 (60 checkpoints, every 5s) is non-null. */
  full_5s_grid_count: number;
  /** Rows with pct_t300 non-null (complete 300s observation). Denominator for full_5s_grid_pct. */
  complete_observations_count: number;
  /** full_5s_grid_count / complete_observations_count, as percentage. Null if no complete obs. */
  full_5s_grid_pct: number | null;
}

export interface EnrichedGraduation {
  id: number;
  mint: string;
  open_price: number | null;
  pct_t30: number | null;
  pct_t60: number | null;
  pct_t300: number | null;
  label: string | null;
  holder_count: number | null;
  top5_wallet_pct: number | null;
  dev_wallet_pct: number | null;
  token_age_minutes: number | null;
  bc_velocity_sol_per_min: number | null;
  total_sol_raised: number | null;
  has_pool: boolean;
  created_at: number;
}

// ──────────────────────────────────────────────────────────────
// Counts & scorecard
// ──────────────────────────────────────────────────────────────

export function computeThesisScorecard(
  db: Database.Database,
  currentBestCombo?: {
    filter_spec: string;
    n: number;
    opt_tp: number | null;
    opt_sl: number | null;
    opt_avg_ret: number | null;
  },
): ThesisScorecard {
  const labels = db.prepare(`
    SELECT label, COUNT(*) as count
    FROM graduation_momentum
    WHERE label IS NOT NULL
    GROUP BY label
  `).all() as Array<{ label: string; count: number }>;

  const pump = labels.find((l) => l.label === 'PUMP')?.count ?? 0;
  const dump = labels.find((l) => l.label === 'DUMP')?.count ?? 0;
  const stable = labels.find((l) => l.label === 'STABLE')?.count ?? 0;
  const totalLabeled = pump + dump + stable;

  const unlabeled = (db.prepare(
    'SELECT COUNT(*) as count FROM graduation_momentum WHERE label IS NULL'
  ).get() as { count: number }).count;

  const rawWinRate = totalLabeled > 0 ? +(pump / totalLabeled * 100).toFixed(1) : null;

  // vel 5-20 cohort (the current best-known baseline)
  const vel = db.prepare(`
    SELECT
      COUNT(*) as n,
      SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
      ROUND(AVG(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
        THEN (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) * 100.0 - 100.0
        END), 2) as avg_return
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND bc_velocity_sol_per_min >= 5
      AND bc_velocity_sol_per_min < 20
      AND pct_t30 IS NOT NULL
      AND pct_t30 >= 5
      AND pct_t30 <= 100
  `).get() as { n: number; pump: number; avg_return: number | null };

  const velWinRate = vel.n > 0 ? +(vel.pump / vel.n * 100).toFixed(1) : null;

  return {
    total_labeled: totalLabeled,
    PUMP: pump,
    DUMP: dump,
    STABLE: stable,
    unlabeled,
    raw_win_rate_pct: rawWinRate,
    vel_5_20_cohort: {
      n: vel.n,
      win_rate_pct: velWinRate,
      avg_return_t30_to_t300_pct: vel.avg_return,
      progress_to_200: `${vel.n}/200`,
    },
    best_known_baseline: currentBestCombo
      ? {
          filter: currentBestCombo.filter_spec,
          opt_sl_pct: currentBestCombo.opt_sl,
          opt_tp_pct: currentBestCombo.opt_tp,
          avg_return_pct: currentBestCombo.opt_avg_ret ?? 0,
          n: currentBestCombo.n,
          note: 'Live leader from leaderboard (n≥100, beats entry-gated baseline). Per-combo optimal TP/SL from SIM_TP_GRID × SIM_SL_GRID — replaces retired fixed 10%SL/50%TP framework (2026-04-21).',
        }
      : {
          filter: 'none',
          opt_sl_pct: null,
          opt_tp_pct: null,
          avg_return_pct: 0,
          n: 0,
          note: 'No live leader yet — no combo has n ≥ 100 with opt_avg_ret > entry-gated baseline + 0.3 pp.',
        },
  };
}

// ──────────────────────────────────────────────────────────────
// Data quality flags
// ──────────────────────────────────────────────────────────────

export function computeDataQualityFlags(db: Database.Database): DataQualityFlags {
  const pipeline = db.prepare(`
    SELECT MAX(timestamp) as last_ts FROM graduations
  `).get() as { last_ts: number | null };

  const last10 = db.prepare(`
    SELECT
      m.graduation_id as id,
      m.open_price_sol,
      m.pct_t300,
      m.holder_count,
      m.top5_wallet_pct,
      m.dev_wallet_pct,
      g.new_pool_address
    FROM graduation_momentum m
    JOIN graduations g ON g.id = m.graduation_id
    ORDER BY m.graduation_id DESC
    LIMIT 10
  `).all() as Array<{
    id: number;
    open_price_sol: number | null;
    pct_t300: number | null;
    holder_count: number | null;
    top5_wallet_pct: number | null;
    dev_wallet_pct: number | null;
    new_pool_address: string | null;
  }>;

  const nullFields: string[] = [];
  for (const row of last10) {
    const missing: string[] = [];
    if (row.open_price_sol === null) missing.push('open_price');
    if (row.pct_t300 === null) missing.push('pct_t300');
    if (row.holder_count === null) missing.push('holders');
    if (row.top5_wallet_pct === null) missing.push('top5');
    if (row.dev_wallet_pct === null) missing.push('dev');
    if (missing.length > 0) nullFields.push(`#${row.id}: ${missing.join(',')}`);
  }

  const allHavePumpswap = last10.length > 0 && last10.every((r) => r.new_pool_address !== null);

  const lastGradSecondsAgo = pipeline.last_ts
    ? Math.floor(Date.now() / 1000) - pipeline.last_ts
    : null;

  // Timestamp drift: check for obviously bad checkpoint ordering on recent rows
  // (skip for now — return false; the v2 panel regime check is richer, handle there)
  const timestampDrift = false;

  // Full 5s grid coverage — what % of complete observations have every pct_tN populated?
  // Pre-rollout rows have NULLs for t65..t295; this surfaces how much of the collected
  // dataset can be used by the widened simulators and new long-horizon path metrics.
  const gridCols: string[] = [];
  for (let sec = 5; sec <= 300; sec += 5) gridCols.push(`pct_t${sec}`);
  const gridNotNull = gridCols.map(c => `${c} IS NOT NULL`).join(' AND ');
  const fullGridCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM graduation_momentum WHERE ${gridNotNull}`
  ).get() as { n: number }).n;
  const completeObsCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM graduation_momentum WHERE pct_t300 IS NOT NULL'
  ).get() as { n: number }).n;
  const fullGridPct = completeObsCount > 0
    ? +(fullGridCount / completeObsCount * 100).toFixed(1)
    : null;

  return {
    price_source_pumpswap_all_last_10: allHavePumpswap,
    null_fields_in_last_10: nullFields,
    last_graduation_seconds_ago: lastGradSecondsAgo,
    stalled: lastGradSecondsAgo !== null && lastGradSecondsAgo > 600,
    timestamp_drift_detected: timestampDrift,
    full_5s_grid_count: fullGridCount,
    complete_observations_count: completeObsCount,
    full_5s_grid_pct: fullGridPct,
  };
}

// ──────────────────────────────────────────────────────────────
// Recent graduations (enriched for dashboard rows)
// ──────────────────────────────────────────────────────────────

export function computeRecentGraduationsEnriched(
  db: Database.Database,
  limit: number = 10,
): EnrichedGraduation[] {
  const rows = db.prepare(`
    SELECT
      m.graduation_id as id,
      g.mint,
      m.open_price_sol,
      m.pct_t30,
      m.pct_t60,
      m.pct_t300,
      m.label,
      m.holder_count,
      m.top5_wallet_pct,
      m.dev_wallet_pct,
      m.token_age_seconds,
      m.bc_velocity_sol_per_min,
      m.total_sol_raised,
      g.new_pool_address,
      g.created_at
    FROM graduation_momentum m
    JOIN graduations g ON g.id = m.graduation_id
    ORDER BY m.graduation_id DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: number;
    mint: string;
    open_price_sol: number | null;
    pct_t30: number | null;
    pct_t60: number | null;
    pct_t300: number | null;
    label: string | null;
    holder_count: number | null;
    top5_wallet_pct: number | null;
    dev_wallet_pct: number | null;
    token_age_seconds: number | null;
    bc_velocity_sol_per_min: number | null;
    total_sol_raised: number | null;
    new_pool_address: string | null;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    mint: r.mint,
    open_price: r.open_price_sol,
    pct_t30: r.pct_t30,
    pct_t60: r.pct_t60,
    pct_t300: r.pct_t300,
    label: r.label,
    holder_count: r.holder_count,
    top5_wallet_pct: r.top5_wallet_pct,
    dev_wallet_pct: r.dev_wallet_pct,
    token_age_minutes: r.token_age_seconds !== null ? +(r.token_age_seconds / 60).toFixed(1) : null,
    bc_velocity_sol_per_min: r.bc_velocity_sol_per_min,
    total_sol_raised: r.total_sol_raised,
    has_pool: r.new_pool_address !== null,
    created_at: r.created_at,
  }));
}

// ──────────────────────────────────────────────────────────────
// Filter catalog + best-combos simulation
//
// Mirrors PANEL_1_FILTERS at src/index.ts:1907. Kept as a WHERE-clause
// string so we can push each filter down to SQLite; the v2 page also uses
// an in-memory predicate, which we don't need here.
// ──────────────────────────────────────────────────────────────

export interface FilterDef {
  name: string;
  group: string;
  where: string; // SQL condition, null-safe (never pass this from user input)
}

export const FILTER_CATALOG: FilterDef[] = [
  // Velocity
  { name: 'vel < 5',            group: 'Velocity', where: 'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 5' },
  { name: 'vel 5-10',           group: 'Velocity', where: 'bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 10' },
  { name: 'vel 5-20',           group: 'Velocity', where: 'bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20' },
  { name: 'vel 10-20',          group: 'Velocity', where: 'bc_velocity_sol_per_min >= 10 AND bc_velocity_sol_per_min < 20' },
  { name: 'vel < 20',           group: 'Velocity', where: 'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20' },
  { name: 'vel < 50',           group: 'Velocity', where: 'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 50' },
  { name: 'vel 20-50',          group: 'Velocity', where: 'bc_velocity_sol_per_min >= 20 AND bc_velocity_sol_per_min < 50' },
  { name: 'vel 50-200',         group: 'Velocity', where: 'bc_velocity_sol_per_min >= 50 AND bc_velocity_sol_per_min < 200' },
  // BC Age
  { name: 'age < 10min',        group: 'BC Age',   where: 'token_age_seconds IS NOT NULL AND token_age_seconds < 600' },
  { name: 'age > 10min',        group: 'BC Age',   where: 'token_age_seconds > 600' },
  { name: 'age > 30min',        group: 'BC Age',   where: 'token_age_seconds > 1800' },
  { name: 'age > 1hr',          group: 'BC Age',   where: 'token_age_seconds > 3600' },
  // Holders
  { name: 'holders >= 5',       group: 'Holders',  where: 'holder_count >= 5' },
  { name: 'holders >= 10',      group: 'Holders',  where: 'holder_count >= 10' },
  { name: 'holders >= 15',      group: 'Holders',  where: 'holder_count >= 15' },
  { name: 'holders >= 18',      group: 'Holders',  where: 'holder_count >= 18' },
  // Top 5 Concentration
  { name: 'top5 < 10%',         group: 'Top 5',    where: 'top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10' },
  { name: 'top5 < 15%',         group: 'Top 5',    where: 'top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 15' },
  { name: 'top5 < 20%',         group: 'Top 5',    where: 'top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 20' },
  // Dev Wallet
  { name: 'dev < 3%',           group: 'Dev',      where: 'dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 3' },
  { name: 'dev < 5%',           group: 'Dev',      where: 'dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 5' },
  // Liquidity (T+30 — available at entry decision time)
  { name: 'liq > 50',           group: 'Liquidity', where: 'liquidity_sol_t30 > 50' },
  { name: 'liq > 100',          group: 'Liquidity', where: 'liquidity_sol_t30 > 100' },
  { name: 'liq > 150',          group: 'Liquidity', where: 'liquidity_sol_t30 > 150' },
  // T+300 liquidity (`liquidity_sol_t300`) is intentionally NOT a FILTER_CATALOG entry —
  // it's future data relative to a T+30 entry decision and using it as an entry filter
  // creates look-ahead bias. The field stays available for backwards-looking research
  // (see exit-sim.ts whale-sell / liq-drop exit simulation).
  // Path shape
  { name: 'mono > 0.5',         group: 'Path Mono', where: 'monotonicity_0_30 > 0.5' },
  { name: 'mono > 0.66',        group: 'Path Mono', where: 'monotonicity_0_30 > 0.66' },
  { name: 'dd > -10%',          group: 'Path DD',   where: 'max_drawdown_0_30 > -10' },
  { name: 'dd > -20%',          group: 'Path DD',   where: 'max_drawdown_0_30 > -20' },
  { name: 'accel > 0',          group: 'Path',      where: 'acceleration_t30 > 0' },
  // Buy pressure
  { name: 'buy_ratio > 0.5',    group: 'Buy Pressure', where: 'buy_pressure_buy_ratio > 0.5' },
  { name: 'buy_ratio > 0.6',    group: 'Buy Pressure', where: 'buy_pressure_buy_ratio > 0.6' },
  { name: 'buyers >= 5',        group: 'Buy Pressure', where: 'buy_pressure_unique_buyers >= 5' },
  { name: 'buyers >= 10',       group: 'Buy Pressure', where: 'buy_pressure_unique_buyers >= 10' },
  { name: 'whale < 30%',        group: 'Buy Pressure', where: 'buy_pressure_whale_pct < 30' },
  { name: 'whale < 50%',        group: 'Buy Pressure', where: 'buy_pressure_whale_pct < 50' },
  // Creator reputation
  { name: 'fresh_dev',          group: 'Creator Rep', where: 'creator_prior_token_count IS NOT NULL AND creator_prior_token_count = 0' },
  { name: 'repeat_dev >= 3',    group: 'Creator Rep', where: 'creator_prior_token_count >= 3' },
  { name: 'clean_dev',          group: 'Creator Rep', where: 'creator_prior_rug_rate IS NOT NULL AND creator_prior_rug_rate < 0.3' },
  { name: 'serial_rugger',      group: 'Creator Rep', where: 'creator_prior_rug_rate >= 0.7' },
  { name: 'rapid_fire',         group: 'Creator Rep', where: 'creator_last_token_age_hours IS NOT NULL AND creator_last_token_age_hours < 1' },
  // Sniper detection — distinct wallets buying in T+0..T+2s window. Populated
  // at T+35 alongside buy_pressure_*, so strategies using these auto-delay 5s.
  { name: 'snipers <= 2',       group: 'Snipers',     where: 'sniper_count_t0_t2 IS NOT NULL AND sniper_count_t0_t2 <= 2' },
  { name: 'snipers <= 5',       group: 'Snipers',     where: 'sniper_count_t0_t2 IS NOT NULL AND sniper_count_t0_t2 <= 5' },
  { name: 'snipers > 5',        group: 'Snipers',     where: 'sniper_count_t0_t2 IS NOT NULL AND sniper_count_t0_t2 > 5' },
  { name: 'snipers > 10',       group: 'Snipers',     where: 'sniper_count_t0_t2 IS NOT NULL AND sniper_count_t0_t2 > 10' },
  // Sniper-wallet velocity = avg # of EARLIER graduations that this graduation's
  // T+0..T+2 buyer wallets also sniped. Higher = more bot-heavy snipe set.
  { name: 'wallet_vel_avg < 5', group: 'Sniper Vel',  where: 'sniper_wallet_velocity_avg IS NOT NULL AND sniper_wallet_velocity_avg < 5' },
  { name: 'wallet_vel_avg < 10',group: 'Sniper Vel',  where: 'sniper_wallet_velocity_avg IS NOT NULL AND sniper_wallet_velocity_avg < 10' },
  { name: 'wallet_vel_avg < 20',group: 'Sniper Vel',  where: 'sniper_wallet_velocity_avg IS NOT NULL AND sniper_wallet_velocity_avg < 20' },
  { name: 'wallet_vel_avg >= 20', group: 'Sniper Vel',where: 'sniper_wallet_velocity_avg >= 20' },
  // B2 — PumpSwap initial pool depth at migration (captured at T+0, available at entry).
  { name: 'init_lp > 15',          group: 'Initial LP', where: 'pumpswap_initial_lp_sol IS NOT NULL AND pumpswap_initial_lp_sol > 15' },
  { name: 'init_lp > 30',          group: 'Initial LP', where: 'pumpswap_initial_lp_sol IS NOT NULL AND pumpswap_initial_lp_sol > 30' },
  { name: 'init_lp > 50',          group: 'Initial LP', where: 'pumpswap_initial_lp_sol IS NOT NULL AND pumpswap_initial_lp_sol > 50' },
  // pumpswap_lp_growth_t0_to_t30_pct is at-entry safe (written at T+30 alongside liquidity_sol_t30).
  { name: 'lp_growth > 0%',        group: 'Initial LP', where: 'pumpswap_lp_growth_t0_to_t30_pct IS NOT NULL AND pumpswap_lp_growth_t0_to_t30_pct > 0' },
  { name: 'lp_growth > 25%',       group: 'Initial LP', where: 'pumpswap_lp_growth_t0_to_t30_pct IS NOT NULL AND pumpswap_lp_growth_t0_to_t30_pct > 25' },
  { name: 'lp_growth > 50%',       group: 'Initial LP', where: 'pumpswap_lp_growth_t0_to_t30_pct IS NOT NULL AND pumpswap_lp_growth_t0_to_t30_pct > 50' },
  // B4 — concurrent-graduation density + batch rank. Self-joined at insert time; T+0 available.
  { name: 'quiet_batch',           group: 'Batch',      where: 'graduation_density_5min IS NOT NULL AND graduation_density_5min <= 2' },
  { name: 'busy_batch',            group: 'Batch',      where: 'graduation_density_5min IS NOT NULL AND graduation_density_5min >= 5' },
  { name: 'first_in_batch',        group: 'Batch',      where: 'batch_rank_within_5min = 1' },
  { name: 'rank <= 2',             group: 'Batch',      where: 'batch_rank_within_5min IS NOT NULL AND batch_rank_within_5min <= 2' },
  { name: 'last_in_batch',         group: 'Batch',      where: 'batch_rank_within_5min IS NOT NULL AND graduation_density_5min IS NOT NULL AND batch_rank_within_5min >= 4 AND batch_rank_within_5min = graduation_density_5min' },
  // B5 — buy/sell flow imbalance + VWAP-pullback at T+30. T+35 fields — strategies auto-delay 5s.
  { name: 'flow_imb > 0',          group: 'Flow',       where: 'flow_imbalance_t30 IS NOT NULL AND flow_imbalance_t30 > 0' },
  { name: 'flow_imb > 0.4',        group: 'Flow',       where: 'flow_imbalance_t30 IS NOT NULL AND flow_imbalance_t30 > 0.4' },
  { name: 'flow_imb > 0.6',        group: 'Flow',       where: 'flow_imbalance_t30 IS NOT NULL AND flow_imbalance_t30 > 0.6' },
  { name: 'flow_imb < 0',          group: 'Flow',       where: 'flow_imbalance_t30 IS NOT NULL AND flow_imbalance_t30 < 0' },
  // price_vs_vwap_t30_pct: positive = price above session VWAP, negative = pulled back below VWAP.
  { name: 'price > vwap',          group: 'VWAP',       where: 'price_vs_vwap_t30_pct IS NOT NULL AND price_vs_vwap_t30_pct > 0' },
  { name: 'vwap_pullback',         group: 'VWAP',       where: 'price_vs_vwap_t30_pct IS NOT NULL AND price_vs_vwap_t30_pct BETWEEN -10 AND -1' },
  { name: 'vwap_pullback strict',  group: 'VWAP',       where: 'price_vs_vwap_t30_pct IS NOT NULL AND price_vs_vwap_t30_pct BETWEEN -5 AND -1 AND monotonicity_0_30 > 0.5' },
  // B3 — first non-bot buyer in T+0..T+5s and their prior-grad sniper history.
  // firstbuyer_priors HIGH = recurring sniper wallet; LOW/0 = fresh wallet (likely retail / discretionary buyer).
  { name: 'firstbuyer_clean',         group: 'First Buyer', where: 'firstbuyer_priors IS NOT NULL AND firstbuyer_priors < 5' },
  { name: 'firstbuyer_known_sniper',  group: 'First Buyer', where: 'firstbuyer_priors IS NOT NULL AND firstbuyer_priors >= 20' },
  { name: 'firstbuyer_serial',        group: 'First Buyer', where: 'firstbuyer_priors IS NOT NULL AND firstbuyer_priors >= 50' },
  // sniper_wallet_velocity_max — max # of earlier grads sniped by ANY single wallet
  // in the T+0..T+2 batch. Column has been populated by the chronological backfill
  // alongside _avg since the original sniper rollout; just hadn't been exposed as
  // research filters until now. Pairs naturally with the _avg filters: a batch can
  // have low avg but high max if one heavy-recidivist drags it (signature of either
  // a coordinated bundle wallet or a single dominant sniper joining a clean cohort).
  { name: 'max_sniper_vel < 5',   group: 'Sniper Vel Max', where: 'sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max < 5' },
  { name: 'max_sniper_vel < 10',  group: 'Sniper Vel Max', where: 'sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max < 10' },
  { name: 'max_sniper_vel >= 20', group: 'Sniper Vel Max', where: 'sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max >= 20' },
  { name: 'max_sniper_vel >= 50', group: 'Sniper Vel Max', where: 'sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max >= 50' },
  // Bundle proxy — canonical multi-wallet bundle signature built from existing
  // columns (zero new RPC). The pattern: 3+ snipers in T+0..T+2 (multi-wallet),
  // no single whale (each individually small — splits across top5 thresholds),
  // all fresh-ish wallets (low max priors — purpose-deployed for this drop).
  // Pair with productive combos to test whether removing bundle-suspects lifts
  // their opt return; if no lift, B1's full RPC-cost bundle detector is unlikely
  // to add edge over what we can already infer.
  { name: 'bundle_suspect', group: 'Bundle Proxy', where: 'sniper_count_t0_t2 IS NOT NULL AND sniper_count_t0_t2 >= 3 AND buy_pressure_whale_pct IS NOT NULL AND buy_pressure_whale_pct < 30 AND sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max < 5' },
  // Inverse: requires sniper data be present (so we know the row was actually
  // evaluated against the bundle pattern) and the pattern is NOT matched.
  { name: 'no_bundle', group: 'Bundle Proxy', where: 'sniper_count_t0_t2 IS NOT NULL AND NOT (sniper_count_t0_t2 >= 3 AND buy_pressure_whale_pct IS NOT NULL AND buy_pressure_whale_pct < 30 AND sniper_wallet_velocity_max IS NOT NULL AND sniper_wallet_velocity_max < 5)' },
];

/** Entry gate shared by all candidates — kept at +5..+100 for research-side
 *  evaluation. Trading default is wider (-99..1000 in `config.ts`) to capture
 *  deep-crash entries; the asymmetry is intentional. Widening this constant
 *  to match trading was tried 2026-05-01 (commit 04dff56) but the heavy-cache
 *  recompute deadlocked Railway — Panel 4/6/7 simulators iterate over eligible
 *  rows × SIM_TP_GRID × SIM_SL_GRID, and a 3× row expansion blew the budget.
 *  Reverted in next commit. Promotion bar comparisons are approximate as a
 *  result — call out in writeups when relevant. */
export const ENTRY_GATE = 'pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100 AND pct_t300 IS NOT NULL';

/** Build the entry gate dynamically for a specific entry checkpoint second.
 *  Mirrors ENTRY_GATE shape but anchors the +5..+100 band on `pct_t<entrySec>`
 *  instead of the hard-coded `pct_t30`. Used by the entry-time-matrix research
 *  panel to evaluate filter combos at later entry points (T+60, T+90, T+120,
 *  T+180, T+240) without touching the live trading flow. */
export function entryGateFor(entrySec: number): string {
  return `pct_t${entrySec} IS NOT NULL AND pct_t${entrySec} >= 5 AND pct_t${entrySec} <= 100 AND pct_t300 IS NOT NULL`;
}

export interface SimulateComboResult {
  n: number;
  pump: number;
  avg_return_t30_to_t300_pct: number | null;
  /** Per-combo optimal take-profit (% from entry) across SIM_TP_GRID × SIM_SL_GRID. Null when n < SIM_MIN_N_FOR_OPTIMUM. */
  opt_tp: number | null;
  /** Per-combo optimal stop-loss (% from entry). */
  opt_sl: number | null;
  /** Avg cost-adjusted return at the optimal (tp, sl) cell. */
  opt_avg_ret: number | null;
  /** Win rate at the optimal (tp, sl) cell. */
  opt_win_rate: number | null;
}

/**
 * One cell of the 12×10 TP/SL grid. tp/sl are the % thresholds from entry,
 * avg_ret is cost-adjusted, win_rate is % of trades with exitRet > 0,
 * n_hit_tp is how many of the n trades actually hit the TP level (used to
 * gate the optimum picker against single-trade outliers).
 */
export interface SimulateComboCell {
  tp: number;
  sl: number;
  avg_ret: number;
  win_rate: number;
  n_hit_tp: number;
}

export interface SimulateComboGridResult {
  n: number;
  pump: number;
  avg_return_t30_to_t300_pct: number | null;
  /** Flat 12×10 grid; index = ti * SIM_SL_GRID.length + si. Always present (even when n < SIM_MIN_N_FOR_OPTIMUM). Empty array when n === 0. */
  grid: SimulateComboCell[];
}

/**
 * Yield to the event loop. Used inside the heavy `computeBestCombos` candidate
 * loop so that each ~50-iteration chunk of synchronous SQLite work is followed
 * by a microtask break, giving HTTP requests, WebSocket callbacks, and timers
 * (especially the price-collector's T+30 deadline) a chance to fire instead of
 * waiting for the entire ~20s loop to finish. Without this the gist-sync cycle
 * blocks the loop end-to-end and causes the timer-drift pattern observed in
 * directPriceCollector.lastT30Timeouts. Exported so other heavy panels in this
 * package can use the same primitive.
 */
export function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** Cadence for inner-loop yields. Tightened from 50 → 10 (2026-05-09) once
 *  panel11 + sniperPanel stopped redundantly re-running this loop — with only
 *  one computeBestCombos call per gist-sync cycle the per-yield budget shrinks
 *  to ~10 × ~13ms simulateCombo = ~130ms, keeping every T+30 deadline timer
 *  well clear of the 1s drift threshold. Extra setImmediate overhead is ~88
 *  yields × 1ms = ~88ms on a 25s compute — lost in the noise. */
const YIELD_EVERY_N_CANDIDATES = 10;

/**
 * Run the per-combo TP/SL grid optimizer against `graduation_momentum`
 * restricted to rows matching `whereClause` (combined with the shared
 * ENTRY_GATE + label gate). For each candidate WHERE subset this walks
 * the SIM_TP_GRID × SIM_SL_GRID (12×10 = 120 cells) and returns the
 * cell with max avg cost-adjusted return, gated by SIM_MIN_N_FOR_OPTIMUM
 * and SIM_MIN_TP_HITS_FOR_OPTIMUM to avoid low-data overfits.
 *
 * Mirrors Panel 4 / Panel 6's in-memory grid (src/api/filter-v2-data.ts ::
 * runFilterPanel4) so best-combos.json and /filter-analysis-v2 stay in sync.
 * Pass a trusted WHERE clause (no user input).
 *
 * `entrySec` (default 30) anchors the entry on `pct_t<entrySec>` and walks
 * checkpoints strictly AFTER that second. Used by the entry-time-matrix
 * research panel to compare T+30 vs T+60 vs T+90 vs T+120 vs T+180 vs T+240
 * entry points on the same combo. Default value preserves backwards-compatible
 * T+30 behavior — every existing caller is unchanged.
 */
/**
 * Compute the full 12×10 TP/SL grid for a candidate filter set without
 * applying the optimum picker. Used by simulateCombo (which then picks the
 * best cell) and by the counterfactual panel (which compares the strategy's
 * configured cell to the top-3 alternatives in the same grid).
 *
 * Same query, same gap penalties, same cost model as simulateCombo — just
 * exposes every cell instead of only the winner.
 */
export function simulateComboFullGrid(
  db: Database.Database,
  whereClause: string,
  entrySec: number = 30,
): SimulateComboGridResult {
  // Walk only checkpoints strictly after the entry — earlier columns are in
  // the past from the entry's perspective and meaningless for the SL/TP walk.
  // For entrySec=30 this preserves the legacy T+40..T+300 walk exactly.
  const walkColsArr = SIM_CHECKPOINT_COLUMNS.filter(c => {
    const sec = parseInt(c.slice(5), 10);
    return sec > entrySec;
  });
  const entryCol = `pct_t${entrySec}`;
  // Dedupe in case the entry column happens to be in SIM_CHECKPOINT_COLUMNS
  // (it currently isn't for entrySec ∈ {30, 60, 90, 120, 180, 240} since those
  // are step-5 / step-10 checkpoints — but stay defensive).
  const selectCols = walkColsArr.includes(entryCol as `pct_t${number}`)
    ? walkColsArr.join(', ')
    : `${entryCol}, ${walkColsArr.join(', ')}`;
  const rows = db.prepare(`
    SELECT
      label,
      ${selectCols},
      round_trip_slippage_pct
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND ${entryGateFor(entrySec)}
      AND (${whereClause})
  `).all() as Array<{
    label: string;
    pct_t300: number;
    round_trip_slippage_pct: number | null;
    [col: string]: number | string | null;
  }>;

  const n = rows.length;
  if (n === 0) {
    return { n: 0, pump: 0, avg_return_t30_to_t300_pct: null, grid: [] };
  }

  let pump = 0;
  let rawRetSum = 0;
  let rawRetN = 0;
  for (const r of rows) {
    if (r.label === 'PUMP') pump++;
    const entryPct = r[entryCol] as number | null | undefined;
    if (typeof entryPct === 'number' && typeof r.pct_t300 === 'number') {
      rawRetSum += ((1 + r.pct_t300 / 100) / (1 + entryPct / 100) - 1) * 100;
      rawRetN++;
    }
  }

  const tpCount = SIM_TP_GRID.length;
  const slCount = SIM_SL_GRID.length;
  const grid: SimulateComboCell[] = new Array(tpCount * slCount);

  for (let ti = 0; ti < tpCount; ti++) {
    const tp = SIM_TP_GRID[ti];
    for (let si = 0; si < slCount; si++) {
      const sl = SIM_SL_GRID[si];
      let sum = 0;
      let wins = 0;
      let tpHits = 0;
      for (let k = 0; k < n; k++) {
        const r = rows[k];
        const entryPct = r[entryCol] as number;
        const entryRatio = 1 + entryPct / 100;
        const stopLevelPct = (entryRatio * (1 - sl / 100) - 1) * 100;
        const tpLevelPct = (entryRatio * (1 + tp / 100) - 1) * 100;
        const cost = r.round_trip_slippage_pct ?? SIM_DEFAULT_COST_PCT;

        let exitRet: number | null = null;
        for (const cp of walkColsArr) {
          const v = r[cp] as number | null | undefined;
          if (v == null) continue;
          if (v <= stopLevelPct) {
            const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
            exitRet = (exitRatio / entryRatio - 1) * 100 - cost;
            break;
          }
          if (v >= tpLevelPct) {
            exitRet = tp * (1 - SIM_TP_GAP_PENALTY) - cost;
            tpHits++;
            break;
          }
        }
        if (exitRet === null) {
          const fallVal = r.pct_t300 as number;
          exitRet = ((1 + fallVal / 100) / entryRatio - 1) * 100 - cost;
        }
        sum += exitRet;
        if (exitRet > 0) wins++;
      }
      grid[ti * slCount + si] = {
        tp, sl,
        avg_ret: +(sum / n).toFixed(2),
        win_rate: +(wins / n * 100).toFixed(1),
        n_hit_tp: tpHits,
      };
    }
  }

  return {
    n,
    pump,
    avg_return_t30_to_t300_pct: rawRetN > 0 ? +(rawRetSum / rawRetN).toFixed(2) : null,
    grid,
  };
}

export function simulateCombo(
  db: Database.Database,
  whereClause: string,
  entrySec: number = 30,
): SimulateComboResult {
  const full = simulateComboFullGrid(db, whereClause, entrySec);
  const { n, pump, avg_return_t30_to_t300_pct, grid } = full;

  if (n === 0) {
    return {
      n: 0,
      pump: 0,
      avg_return_t30_to_t300_pct: null,
      opt_tp: null,
      opt_sl: null,
      opt_avg_ret: null,
      opt_win_rate: null,
    };
  }

  // Pick the optimum: max avg among cells with tp_hits >= SIM_MIN_TP_HITS_FOR_OPTIMUM,
  // gated on n >= SIM_MIN_N_FOR_OPTIMUM.
  let opt: SimulateComboCell | null = null;
  if (n >= SIM_MIN_N_FOR_OPTIMUM) {
    for (const cell of grid) {
      if (cell.n_hit_tp < SIM_MIN_TP_HITS_FOR_OPTIMUM) continue;
      if (opt === null || cell.avg_ret > opt.avg_ret) opt = cell;
    }
  }

  return {
    n,
    pump,
    avg_return_t30_to_t300_pct,
    opt_tp: opt ? opt.tp : null,
    opt_sl: opt ? opt.sl : null,
    opt_avg_ret: opt ? opt.avg_ret : null,
    opt_win_rate: opt ? opt.win_rate : null,
  };
}

/** Reconstruct the combined SQL WHERE for a list of filter names in FILTER_CATALOG. */
export function whereForFilterNames(names: string[]): string | null {
  const clauses: string[] = [];
  for (const name of names) {
    const f = FILTER_CATALOG.find((x) => x.name === name);
    if (!f) return null;
    clauses.push(`(${f.where})`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

export interface BestComboRow {
  filter_spec: string;        // e.g. "vel 5-20 + holders >= 10"
  filters: string[];          // individual filter names for machine parsing
  n: number;
  win_rate_pct: number | null;                 // PUMP-label rate on raw labeled subset (pre-simulation)
  avg_return_t30_to_t300_pct: number | null;   // raw buy-and-hold return T+30 → T+300
  opt_tp: number | null;                       // per-combo optimal TP across SIM_TP_GRID × SIM_SL_GRID
  opt_sl: number | null;                       // per-combo optimal SL
  opt_avg_ret: number | null;                  // avg cost-adjusted return at the optimum cell
  opt_win_rate: number | null;                 // win rate at the optimum cell
  beats_baseline: boolean;                     // opt_avg_ret > baseline + 0.3pp on n ≥ 100
}

/**
 * Rank filters and filter pairs by per-combo TP/SL-optimized simulation on
 * labeled rows. Each candidate is run through the SIM_TP_GRID × SIM_SL_GRID
 * (12×10 cells) and reported at its own best cell — matches Panel 6's
 * `top_pairs` approach in filter-v2-data.ts. Supersedes the earlier fixed
 * 10%SL/50%TP ranking (retired 2026-04-21).
 */
export async function computeBestCombos(
  db: Database.Database,
  opts: { min_n?: number; top?: number; include_pairs?: boolean } = {},
): Promise<{ generated_at: string; baseline_avg_return_pct: number; rows: BestComboRow[] }> {
  const minN = opts.min_n ?? 20;
  const top = opts.top ?? 20;
  const includePairs = opts.include_pairs !== false;
  // Baseline: avg cost-adjusted return across ALL entry-gated labeled rows at
  // their own grid optimum. Updated each run so promotion gate (+0.3 pp) is
  // meaningful against the current population, not a stale historical anchor.
  const baselineResult = simulateCombo(db, '1=1');
  const baseline = baselineResult.opt_avg_ret ?? 0;

  // Single filters
  const candidates: Array<{ name: string; filters: string[]; where: string }> = [];
  for (const f of FILTER_CATALOG) {
    candidates.push({
      name: f.name,
      filters: [f.name],
      where: f.where,
    });
  }

  // Cross-group pairs — avoid pairing within the same group (e.g. two velocity buckets)
  if (includePairs) {
    for (let i = 0; i < FILTER_CATALOG.length; i++) {
      for (let j = i + 1; j < FILTER_CATALOG.length; j++) {
        const a = FILTER_CATALOG[i];
        const b = FILTER_CATALOG[j];
        if (a.group === b.group) continue;
        candidates.push({
          name: `${a.name} + ${b.name}`,
          filters: [a.name, b.name],
          where: `(${a.where}) AND (${b.where})`,
        });
      }
    }
  }

  // Evaluate each candidate via SQL aggregation. Yield every
  // YIELD_EVERY_N_CANDIDATES iterations so the main loop stays responsive —
  // see yieldEventLoop comment for the timer-drift rationale.
  const rows: BestComboRow[] = [];
  let iter = 0;
  for (const c of candidates) {
    if (iter > 0 && iter % YIELD_EVERY_N_CANDIDATES === 0) {
      await yieldEventLoop();
    }
    iter++;
    const result = simulateCombo(db, c.where);
    if (result.n < minN) continue;

    rows.push({
      filter_spec: c.name,
      filters: c.filters,
      n: result.n,
      win_rate_pct: result.n > 0 ? +(result.pump / result.n * 100).toFixed(1) : null,
      avg_return_t30_to_t300_pct: result.avg_return_t30_to_t300_pct,
      opt_tp: result.opt_tp,
      opt_sl: result.opt_sl,
      opt_avg_ret: result.opt_avg_ret,
      opt_win_rate: result.opt_win_rate,
      beats_baseline: result.opt_avg_ret !== null && result.n >= 100 && result.opt_avg_ret > baseline + 0.3,
    });
  }

  // Sort by per-combo opt_avg_ret (nulls last), then by n
  rows.sort((a, b) => {
    const av = a.opt_avg_ret;
    const bv = b.opt_avg_ret;
    if (av === null && bv === null) return b.n - a.n;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return b.n - a.n;
  });

  return {
    generated_at: new Date().toISOString(),
    baseline_avg_return_pct: +baseline.toFixed(2),
    rows: rows.slice(0, top),
  };
}
