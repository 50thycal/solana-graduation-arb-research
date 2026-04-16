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
    sl_pct: number;
    tp_pct: number;
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
  currentBestCombo?: { filter_spec: string; n: number; sim_avg_return_10sl_50tp_pct: number | null },
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
          sl_pct: 10,
          tp_pct: 50,
          avg_return_pct: currentBestCombo.sim_avg_return_10sl_50tp_pct ?? 0,
          n: currentBestCombo.n,
          note: 'Live leader from leaderboard (n≥100, beats old baseline). Sim return updates as new data arrives — value at promotion is recorded in CLAUDE.md.',
        }
      : {
          filter: 'vel < 20 + top5 < 10%',
          sl_pct: 10,
          tp_pct: 50,
          avg_return_pct: 5.31,
          n: 118,
          note: 'Current best-known baseline — leaderboard not yet computed. See CLAUDE.md for promotion value.',
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

  return {
    price_source_pumpswap_all_last_10: allHavePumpswap,
    null_fields_in_last_10: nullFields,
    last_graduation_seconds_ago: lastGradSecondsAgo,
    stalled: lastGradSecondsAgo !== null && lastGradSecondsAgo > 600,
    timestamp_drift_detected: timestampDrift,
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
  // Liquidity
  { name: 'liq > 50',           group: 'Liquidity', where: 'liquidity_sol_t30 > 50' },
  { name: 'liq > 100',          group: 'Liquidity', where: 'liquidity_sol_t30 > 100' },
  { name: 'liq > 150',          group: 'Liquidity', where: 'liquidity_sol_t30 > 150' },
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
];

/** Entry gate shared by all candidates — matches the baseline. */
const ENTRY_GATE = 'pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100 AND pct_t300 IS NOT NULL';

export interface BestComboRow {
  filter_spec: string;        // e.g. "vel 5-20 + holders >= 10"
  filters: string[];          // individual filter names for machine parsing
  n: number;
  win_rate_pct: number | null;
  avg_return_t30_to_t300_pct: number | null;
  sim_avg_return_10sl_50tp_pct: number | null;
  sim_win_rate_10sl_50tp_pct: number | null;
  beats_baseline: boolean;    // sim_avg_return > baseline + 0.3pp on n>=100
}

/** Rank filters and filter pairs by 10%SL/50%TP simulation on labeled rows. */
export function computeBestCombos(
  db: Database.Database,
  opts: { min_n?: number; top?: number; include_pairs?: boolean } = {},
): { generated_at: string; baseline_avg_return_pct: number; rows: BestComboRow[] } {
  const minN = opts.min_n ?? 20;
  const top = opts.top ?? 20;
  const includePairs = opts.include_pairs !== false;
  const baseline = 1.4;

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

  // Evaluate each candidate via SQL aggregation
  const rows: BestComboRow[] = [];
  for (const c of candidates) {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as n,
        SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
        AVG((1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) * 100.0 - 100.0) as avg_return
      FROM graduation_momentum
      WHERE label IS NOT NULL
        AND ${ENTRY_GATE}
        AND (${c.where})
    `).get() as { n: number; pump: number; avg_return: number | null };

    if (stats.n < minN) continue;

    // Simulate 10% SL / 50% TP over the rows (pct_t40 .. pct_t300 fall-through).
    const simRows = db.prepare(`
      SELECT
        pct_t30, pct_t40, pct_t50, pct_t60, pct_t90,
        pct_t120, pct_t150, pct_t180, pct_t240, pct_t300,
        round_trip_slippage_pct
      FROM graduation_momentum
      WHERE label IS NOT NULL
        AND ${ENTRY_GATE}
        AND (${c.where})
    `).all() as Array<{
      pct_t30: number;
      pct_t40: number | null;
      pct_t50: number | null;
      pct_t60: number | null;
      pct_t90: number | null;
      pct_t120: number | null;
      pct_t150: number | null;
      pct_t180: number | null;
      pct_t240: number | null;
      pct_t300: number;
      round_trip_slippage_pct: number | null;
    }>;

    let simSum = 0;
    let simWins = 0;
    let simN = 0;
    const SL_GAP = 0.30;   // adverse gap on stop-loss exits — price-multiplier model, mirrors trade-logger.ts:112
    const TP_GAP = 0.10;   // adverse gap on take-profit exits
    const DEFAULT_COST = 3.0;
    const checkpoints: Array<'pct_t40'|'pct_t50'|'pct_t60'|'pct_t90'|'pct_t120'|'pct_t150'|'pct_t180'|'pct_t240'|'pct_t300'> =
      ['pct_t40','pct_t50','pct_t60','pct_t90','pct_t120','pct_t150','pct_t180','pct_t240','pct_t300'];

    for (const r of simRows) {
      const ep = r.pct_t30;
      const openM = 1 + ep / 100;
      const slLvl = (openM * 0.9 - 1) * 100;      // 10% SL from entry
      const tpLvl = (openM * 1.5 - 1) * 100;      // 50% TP from entry
      const cost = r.round_trip_slippage_pct ?? DEFAULT_COST;

      let exit: number | null = null;
      for (const cp of checkpoints) {
        const cv = r[cp];
        if (cv === null) continue;
        if (cv <= slLvl) {
          // Price-multiplier gap: observed price * (1 - SL_GAP), return vs entry
          const exitRatio = (1 + cv / 100) * (1 - SL_GAP);
          exit = (exitRatio / openM - 1) * 100;
          break;
        }
        if (cv >= tpLvl) { exit = 50 * (1 - TP_GAP); break; }
      }
      if (exit === null) {
        // Fall through to T+300 — compute return from entry to T+300
        exit = ((1 + r.pct_t300 / 100) / (1 + ep / 100) - 1) * 100;
      }
      const net = exit - cost;
      simSum += net;
      if (net > 0) simWins++;
      simN++;
    }

    const simAvg = simN > 0 ? +(simSum / simN).toFixed(2) : null;
    const simWr = simN > 0 ? +(simWins / simN * 100).toFixed(1) : null;

    rows.push({
      filter_spec: c.name,
      filters: c.filters,
      n: stats.n,
      win_rate_pct: stats.n > 0 ? +(stats.pump / stats.n * 100).toFixed(1) : null,
      avg_return_t30_to_t300_pct: stats.avg_return !== null ? +stats.avg_return.toFixed(2) : null,
      sim_avg_return_10sl_50tp_pct: simAvg,
      sim_win_rate_10sl_50tp_pct: simWr,
      beats_baseline: simAvg !== null && stats.n >= 100 && simAvg > baseline + 0.3,
    });
  }

  // Sort by simulation avg return (nulls last), then by n
  rows.sort((a, b) => {
    const av = a.sim_avg_return_10sl_50tp_pct;
    const bv = b.sim_avg_return_10sl_50tp_pct;
    if (av === null && bv === null) return b.n - a.n;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return b.n - a.n;
  });

  return {
    generated_at: new Date().toISOString(),
    baseline_avg_return_pct: baseline,
    rows: rows.slice(0, top),
  };
}
