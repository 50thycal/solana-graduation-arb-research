/**
 * src/api/exit-sim-matrix.ts
 *
 * Cross-combo exit-strategy matrix. For each of the top-20 filter combos
 * from computeBestCombos(), re-run the full exit-strategy grid from
 * computeExitSim() and surface the best-cell-per-strategy plus its delta
 * vs the combo's OWN static 10%SL/50%TP baseline.
 *
 * Answers: "which (combo × dynamic-exit) pair lifts return the most above
 * that combo's fixed-exit baseline?" — the research question the single-
 * universe /exit-sim page can't answer.
 *
 * Reuses:
 *   - computeBestCombos() + whereForFilterNames() from aggregates.ts
 *   - computeExitSim({ extraWhere }) from exit-sim.ts — SQL-prefiltered
 *
 * Output is compact: only the per-strategy best cell, not the full grid
 * (the user can visit /exit-sim?combo=<filter_spec> to see cells).
 */

import type Database from 'better-sqlite3';
import { computeBestCombos, whereForFilterNames } from './aggregates';
import {
  computeExitSim,
  loadExitSimRows,
  simulateStaticOnRows,
  type GridCell,
  type ExitReason,
} from './exit-sim';

const MIN_N_FOR_COMBO = 30;

// Per-combo static TP/SL grid. Small enough to run 20x per sync cycle without
// noticeable cost. Covers the common trader ranges — tight/loose SL × modest/
// aggressive TP. Picking the optimal cell gives each combo its own fair
// baseline instead of forcing the global 10/50 default onto combos it wasn't
// tuned for.
const STATIC_SL_GRID = [5, 10, 15, 20] as const;
const STATIC_TP_GRID = [25, 50, 75, 100] as const;

export interface MatrixStrategyCell {
  strategy: 'momentum_reversal' | 'scale_out' | 'vol_adaptive' | 'time_decayed_tp' | 'whale_liq';
  /** null when n < MIN_N_FOR_COMBO for every cell in this strategy's grid. */
  best_params: Record<string, number | string> | null;
  best_n: number;
  best_avg_return_pct: number | null;
  best_win_rate_pct: number | null;
  /** Δ vs this combo's own static 10%SL/50%TP baseline (same universe). */
  delta_vs_static_pp: number | null;
  /** Top exit reason in the best cell (nullable if no cell). */
  top_exit_reason: ExitReason | null;
}

export interface MatrixRow {
  filter_spec: string;
  filters: string[];
  n_rows: number;
  /** Return at the GLOBAL 10%SL/50%TP — what /api/best-combos ranks on. */
  static_10_50_return_pct: number | null;
  /** Per-combo best static cell across the (SL × TP) grid. This combo's own
   *  natural fit, and the fair baseline for Δ comparisons. */
  static_optimal_return_pct: number | null;
  static_optimal_win_rate_pct: number | null;
  static_optimal_sl_pct: number | null;
  static_optimal_tp_pct: number | null;
  leaderboard_sim_return_pct: number | null;   // from /api/best-combos — sanity check
  strategies: MatrixStrategyCell[];
  /** Best Δ across all 5 strategies — used as the row-level sort key.
   *  Compared against `static_optimal_return_pct`, not 10/50. */
  best_delta_pp: number | null;
  best_strategy: string | null;
}

export interface ExitSimMatrixData {
  generated_at: string;
  min_n_per_cell: number;
  rows: MatrixRow[];
}

/**
 * Pick the highest-return cell from a grid, subject to MIN_N_FOR_COMBO.
 * Returns null if no cell clears the sample-size bar.
 */
function pickBestCell(grid: GridCell[]): GridCell | null {
  let best: GridCell | null = null;
  for (const c of grid) {
    if (c.n < MIN_N_FOR_COMBO) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || c.avg_return_pct > (best.avg_return_pct ?? -Infinity)) best = c;
  }
  return best;
}

function topExitReason(bd: Record<ExitReason, number>): ExitReason | null {
  let max = 0;
  let winner: ExitReason | null = null;
  for (const [k, v] of Object.entries(bd) as Array<[ExitReason, number]>) {
    if (v > max) { max = v; winner = k; }
  }
  return winner;
}

function cellFrom(
  strategy: MatrixStrategyCell['strategy'],
  best: GridCell | null,
  staticReturn: number | null,
): MatrixStrategyCell {
  if (!best || best.avg_return_pct == null) {
    return {
      strategy,
      best_params: null,
      best_n: 0,
      best_avg_return_pct: null,
      best_win_rate_pct: null,
      delta_vs_static_pp: null,
      top_exit_reason: null,
    };
  }
  const delta = staticReturn != null
    ? +(best.avg_return_pct - staticReturn).toFixed(2)
    : null;
  return {
    strategy,
    best_params: best.params,
    best_n: best.n,
    best_avg_return_pct: best.avg_return_pct,
    best_win_rate_pct: best.win_rate_pct,
    delta_vs_static_pp: delta,
    top_exit_reason: topExitReason(best.exit_reason_breakdown),
  };
}

export function computeExitSimMatrix(db: Database.Database): ExitSimMatrixData {
  const leaderboard = computeBestCombos(db, {
    min_n: 20,
    top: 20,
    include_pairs: true,
  });

  const rows: MatrixRow[] = [];

  for (const lb of leaderboard.rows) {
    const where = whereForFilterNames(lb.filters);
    if (!where) continue;

    // Load rows once per combo for the static-grid sweep. computeExitSim()
    // below will re-query but that's OK — SQLite is fast and this keeps the
    // static sweep decoupled from the evaluator pipeline.
    const staticRows = loadExitSimRows(db, where);

    // Find the per-combo optimal static cell across the (SL × TP) grid.
    let optimalStatic: GridCell | null = null;
    for (const sl of STATIC_SL_GRID) {
      for (const tp of STATIC_TP_GRID) {
        const cell = simulateStaticOnRows(staticRows, sl, tp);
        if (cell.avg_return_pct == null) continue;
        if (!optimalStatic || optimalStatic.avg_return_pct == null
            || cell.avg_return_pct > optimalStatic.avg_return_pct) {
          optimalStatic = cell;
        }
      }
    }

    // Static at the global default — kept as a reference column so the matrix
    // row reconciles with /api/best-combos' leaderboard value.
    const static10_50 = simulateStaticOnRows(staticRows, 10, 50);

    const sim = computeExitSim(db, {
      extraWhere: where,
      universeLabel: lb.filter_spec,
    });

    const baseline = optimalStatic?.avg_return_pct ?? null;
    const s = sim.strategies;

    const cells: MatrixStrategyCell[] = [
      cellFrom('momentum_reversal', pickBestCell(s.momentum_reversal.grid), baseline),
      cellFrom('scale_out',         pickBestCell(s.scale_out.grid),         baseline),
      cellFrom('vol_adaptive',      pickBestCell(s.vol_adaptive.grid),      baseline),
      cellFrom('time_decayed_tp',   pickBestCell(s.time_decayed_tp.grid),   baseline),
      cellFrom('whale_liq',         pickBestCell(s.whale_liq.grid),         baseline),
    ];

    let bestDelta: number | null = null;
    let bestStrategy: string | null = null;
    for (const c of cells) {
      if (c.delta_vs_static_pp == null) continue;
      if (bestDelta == null || c.delta_vs_static_pp > bestDelta) {
        bestDelta = c.delta_vs_static_pp;
        bestStrategy = c.strategy;
      }
    }

    rows.push({
      filter_spec: lb.filter_spec,
      filters: lb.filters,
      n_rows: sim.universe.n_rows,
      static_10_50_return_pct: static10_50.avg_return_pct,
      static_optimal_return_pct: optimalStatic?.avg_return_pct ?? null,
      static_optimal_win_rate_pct: optimalStatic?.win_rate_pct ?? null,
      static_optimal_sl_pct: (optimalStatic?.params.sl_pct as number | undefined) ?? null,
      static_optimal_tp_pct: (optimalStatic?.params.tp_pct as number | undefined) ?? null,
      leaderboard_sim_return_pct: lb.sim_avg_return_10sl_50tp_pct,
      strategies: cells,
      best_delta_pp: bestDelta,
      best_strategy: bestStrategy,
    });
  }

  // Sort by best delta descending (combos that gain the most from dynamic exits first).
  // Null deltas (too-thin cell grids) drop to the bottom but keep their slot order.
  rows.sort((a, b) => {
    if (a.best_delta_pp == null && b.best_delta_pp == null) return 0;
    if (a.best_delta_pp == null) return 1;
    if (b.best_delta_pp == null) return -1;
    return b.best_delta_pp - a.best_delta_pp;
  });

  return {
    generated_at: new Date().toISOString(),
    min_n_per_cell: MIN_N_FOR_COMBO,
    rows,
  };
}
