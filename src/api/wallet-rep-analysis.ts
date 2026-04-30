/**
 * src/api/wallet-rep-analysis.ts
 *
 * Answers: "If we layer a creator-wallet-reputation filter on top of each of
 * the top 20 combos from /api/best-combos, how does sim return change?"
 *
 * Reuses the existing simulation engine (simulateCombo in aggregates.ts) so
 * the TP/SL/gap/slippage model is identical to the leaderboard. The only
 * difference here is that each combo's SQL WHERE gets AND'd with a wallet-rep
 * modifier before the simulation runs.
 *
 * Rep filters are curated creator-only modifiers sourced from fields already
 * on graduation_momentum (creator_prior_token_count, creator_prior_rug_rate,
 * creator_prior_avg_return, creator_last_token_age_hours) — no schema changes.
 */

import Database from 'better-sqlite3';

import {
  computeBestCombos,
  simulateCombo,
  whereForFilterNames,
} from './aggregates';
import { SIM_MIN_N_FOR_OPTIMUM } from './sim-constants';

export interface WalletRepFilterDef {
  name: string;
  description: string;
  where: string; // SQL condition — trusted literal
}

export const WALLET_REP_FILTERS: WalletRepFilterDef[] = [
  {
    name: 'clean_dev',
    description: 'creator_prior_rug_rate < 0.3',
    where: 'creator_prior_rug_rate IS NOT NULL AND creator_prior_rug_rate < 0.3',
  },
  {
    name: 'not_serial_rugger',
    description: 'rug_rate < 0.7 (or unknown creator)',
    where: 'creator_prior_rug_rate IS NULL OR creator_prior_rug_rate < 0.7',
  },
  {
    name: 'fresh_dev',
    description: 'creator_prior_token_count = 0',
    where: 'creator_prior_token_count = 0',
  },
  {
    name: 'known_dev',
    description: 'creator_prior_token_count >= 1',
    where: 'creator_prior_token_count >= 1',
  },
  {
    name: 'repeat_dev_3plus',
    description: 'creator_prior_token_count >= 3',
    where: 'creator_prior_token_count >= 3',
  },
  {
    name: 'profitable_dev',
    description: 'creator_prior_avg_return > 0',
    where: 'creator_prior_avg_return IS NOT NULL AND creator_prior_avg_return > 0',
  },
  {
    name: 'profitable_dev_strong',
    description: 'creator_prior_avg_return > 10',
    where: 'creator_prior_avg_return IS NOT NULL AND creator_prior_avg_return > 10',
  },
  {
    name: 'not_rapid_fire',
    description: 'last_token_age_hours >= 1 (or unknown)',
    where: 'creator_last_token_age_hours IS NULL OR creator_last_token_age_hours >= 1',
  },
];

export interface WalletRepCell {
  n: number;
  /** Per-combo optimal TP (% from entry) for this rep-modified subset — null if n < SIM_MIN_N_FOR_OPTIMUM. */
  opt_tp: number | null;
  /** Per-combo optimal SL (% from entry). */
  opt_sl: number | null;
  /** Avg cost-adjusted return at the optimum cell. */
  opt_avg_ret: number | null;
  /** Win rate at the optimum cell. */
  opt_win_rate: number | null;
  /** Δ opt_avg_ret between this cell and the rep-unmodified base (positive = rep helps). Null when either side lacks n. */
  delta_opt_ret_pp: number | null;
  delta_n: number;
  n_retention_pct: number | null;
}

export interface WalletRepRow {
  filter_spec: string;
  filters: string[];
  base: WalletRepCell;
  cells: Record<string, WalletRepCell>;
}

export interface WalletRepSummary {
  rep_filter: string;
  description: string;
  mean_delta_pp: number | null;
  median_delta_pp: number | null;
  combos_improved: number;
  combos_worsened: number;
  combos_evaluated: number;
  mean_n_retention_pct: number | null;
  /** Combos where the cell has at least 1 row (regardless of opt threshold) — diagnostic for "is the data being captured". */
  combos_with_any_n: number;
}

/** Coverage of the `creator_prior_*` columns across the entry-gated labeled population. */
export interface WalletRepCoverage {
  total_labeled_rows: number;
  with_prior_count: number;
  with_prior_count_ge_1: number;
  with_prior_count_ge_3: number;
  with_creator_wallet: number;
  prior_count_coverage_pct: number;
  creator_wallet_coverage_pct: number;
}

export interface WalletRepAnalysisData {
  generated_at: string;
  baseline_avg_return_pct: number;
  rep_filters: Array<{ name: string; description: string }>;
  rows: WalletRepRow[];
  summary: WalletRepSummary[];
  coverage: WalletRepCoverage;
  notes: {
    min_n_for_valid_delta: number;
    combo_source: string;
    framework: string;
  };
}

// A delta is only published when the rep-modified cell can also produce an
// opt TP/SL (simulateCombo's gate). If we set this lower than
// SIM_MIN_N_FOR_OPTIMUM the cells in [MIN_N, SIM_MIN_N_FOR_OPTIMUM) come back
// with opt_avg_ret = null, the delta becomes null, and the row silently drops
// from the leaderboard — making it look like the data isn't being collected
// when in fact it is. Keep these aligned.
const MIN_N_FOR_DELTA = SIM_MIN_N_FOR_OPTIMUM;

function makeCell(
  base: { n: number; opt_avg_ret: number | null },
  filtered: ReturnType<typeof simulateCombo>,
): WalletRepCell {
  const delta =
    base.opt_avg_ret !== null && filtered.opt_avg_ret !== null && filtered.n >= MIN_N_FOR_DELTA
      ? +(filtered.opt_avg_ret - base.opt_avg_ret).toFixed(2)
      : null;
  const retention =
    base.n > 0 ? +((filtered.n / base.n) * 100).toFixed(1) : null;

  return {
    n: filtered.n,
    opt_tp: filtered.opt_tp,
    opt_sl: filtered.opt_sl,
    opt_avg_ret: filtered.opt_avg_ret,
    opt_win_rate: filtered.opt_win_rate,
    delta_opt_ret_pp: delta,
    delta_n: filtered.n - base.n,
    n_retention_pct: retention,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2)
    : +sorted[mid].toFixed(2);
}

export function computeWalletRepAnalysis(
  db: Database.Database,
): WalletRepAnalysisData {
  const leaderboard = computeBestCombos(db, {
    min_n: 20,
    top: 20,
    include_pairs: true,
  });

  const rows: WalletRepRow[] = [];

  for (const lbRow of leaderboard.rows) {
    const baseWhere = whereForFilterNames(lbRow.filters);
    if (!baseWhere) continue; // should never happen — filters come from FILTER_CATALOG

    // Base cell — just re-run the simulation to keep numbers self-consistent
    // with the cells (single source of truth). Should match leaderboard exactly.
    const baseResult = simulateCombo(db, baseWhere);
    const baseCell: WalletRepCell = {
      n: baseResult.n,
      opt_tp: baseResult.opt_tp,
      opt_sl: baseResult.opt_sl,
      opt_avg_ret: baseResult.opt_avg_ret,
      opt_win_rate: baseResult.opt_win_rate,
      delta_opt_ret_pp: 0,
      delta_n: 0,
      n_retention_pct: 100,
    };

    const cells: Record<string, WalletRepCell> = {};
    for (const rep of WALLET_REP_FILTERS) {
      const combinedWhere = `(${baseWhere}) AND (${rep.where})`;
      const result = simulateCombo(db, combinedWhere);
      cells[rep.name] = makeCell(
        { n: baseResult.n, opt_avg_ret: baseResult.opt_avg_ret },
        result,
      );
    }

    rows.push({
      filter_spec: lbRow.filter_spec,
      filters: lbRow.filters,
      base: baseCell,
      cells,
    });
  }

  // Aggregate across the rows to rank rep filters
  const summary: WalletRepSummary[] = WALLET_REP_FILTERS.map((rep) => {
    const deltas: number[] = [];
    const retentions: number[] = [];
    let improved = 0;
    let worsened = 0;
    let combosWithAnyN = 0;

    for (const row of rows) {
      const cell = row.cells[rep.name];
      if (cell.delta_opt_ret_pp !== null) {
        deltas.push(cell.delta_opt_ret_pp);
        if (cell.delta_opt_ret_pp > 0) improved++;
        else if (cell.delta_opt_ret_pp < 0) worsened++;
      }
      if (cell.n_retention_pct !== null) retentions.push(cell.n_retention_pct);
      if (cell.n > 0) combosWithAnyN++;
    }

    const mean =
      deltas.length > 0
        ? +(deltas.reduce((s, x) => s + x, 0) / deltas.length).toFixed(2)
        : null;
    const meanRetention =
      retentions.length > 0
        ? +(retentions.reduce((s, x) => s + x, 0) / retentions.length).toFixed(1)
        : null;

    return {
      rep_filter: rep.name,
      description: rep.description,
      mean_delta_pp: mean,
      median_delta_pp: median(deltas),
      combos_improved: improved,
      combos_worsened: worsened,
      combos_evaluated: deltas.length,
      mean_n_retention_pct: meanRetention,
      combos_with_any_n: combosWithAnyN,
    };
  }).sort((a, b) => {
    if (a.mean_delta_pp === null && b.mean_delta_pp === null) return 0;
    if (a.mean_delta_pp === null) return 1;
    if (b.mean_delta_pp === null) return -1;
    return b.mean_delta_pp - a.mean_delta_pp;
  });

  // Coverage diagnostic: how many entry-gated labeled rows actually carry
  // creator_prior_* values. Answers "is the data being captured?" directly,
  // independent of the optimizer threshold above.
  const coverageRow = db.prepare(`
    SELECT
      COUNT(*) AS total_labeled,
      SUM(CASE WHEN creator_prior_token_count IS NOT NULL THEN 1 ELSE 0 END) AS with_prior,
      SUM(CASE WHEN creator_prior_token_count IS NOT NULL AND creator_prior_token_count >= 1 THEN 1 ELSE 0 END) AS with_prior_ge_1,
      SUM(CASE WHEN creator_prior_token_count IS NOT NULL AND creator_prior_token_count >= 3 THEN 1 ELSE 0 END) AS with_prior_ge_3,
      SUM(CASE WHEN creator_wallet_address IS NOT NULL THEN 1 ELSE 0 END) AS with_creator
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND pct_t30 BETWEEN 5 AND 100
  `).get() as {
    total_labeled: number;
    with_prior: number;
    with_prior_ge_1: number;
    with_prior_ge_3: number;
    with_creator: number;
  };

  const total = coverageRow.total_labeled || 0;
  const coverage: WalletRepCoverage = {
    total_labeled_rows: total,
    with_prior_count: coverageRow.with_prior || 0,
    with_prior_count_ge_1: coverageRow.with_prior_ge_1 || 0,
    with_prior_count_ge_3: coverageRow.with_prior_ge_3 || 0,
    with_creator_wallet: coverageRow.with_creator || 0,
    prior_count_coverage_pct:
      total > 0 ? +((coverageRow.with_prior / total) * 100).toFixed(1) : 0,
    creator_wallet_coverage_pct:
      total > 0 ? +((coverageRow.with_creator / total) * 100).toFixed(1) : 0,
  };

  return {
    generated_at: new Date().toISOString(),
    baseline_avg_return_pct: leaderboard.baseline_avg_return_pct,
    coverage,
    rep_filters: WALLET_REP_FILTERS.map((r) => ({
      name: r.name,
      description: r.description,
    })),
    rows,
    summary,
    notes: {
      min_n_for_valid_delta: MIN_N_FOR_DELTA,
      combo_source: 'computeBestCombos(min_n=20, top=20, include_pairs=true)',
      framework: 'per-combo opt TP/SL from SIM_TP_GRID × SIM_SL_GRID (matches Panel 6 top_pairs)',
    },
  };
}
