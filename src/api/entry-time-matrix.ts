/**
 * src/api/entry-time-matrix.ts
 *
 * Entry-time × filter-combo matrix. For each combo from the standard
 * computeBestCombos() leaderboard plus every standalone FILTER_CATALOG
 * entry, re-run the per-combo TP/SL grid optimizer at every candidate
 * entry checkpoint (T+30, T+60, T+90, T+120, T+180, T+240) and report
 * the per-cell n / opt_tp / opt_sl / opt_avg_ret / opt_win_rate.
 *
 * Answers the question the late-entry research handoff asked:
 *   "Is T+30 actually the right entry time, or does waiting a bit lift
 *    the optimum on most combos?"
 *
 * Mirror of exit-sim-matrix.ts in shape:
 *   - rebuilds candidate WHERE clauses from the FILTER_CATALOG + best-combos
 *     pair leaderboard
 *   - calls simulateCombo(db, where, entrySec) — the new entrySec parameter
 *     anchors the return on pct_t<entrySec> and walks checkpoints strictly
 *     after that second
 *   - per-row "best_entry_sec" = the column with the highest opt_avg_ret
 *   - "delta_vs_t30_pp" = best - T+30 (the live-trading default)
 *
 * Important caveat: each entry-time column has a DIFFERENT n. Late entries
 * have fewer rows because not every observation has a non-null pct_t<sec>
 * checkpoint (only 15.6% of complete observations had the full 5s grid as
 * of 2026-05-02). Cells with n < MIN_N_PER_CELL are reported but flagged.
 *
 * Path-shape filters (mono_*, dd_*, accel_*, sum_abs_*) require pct_t5..pct_t30
 * non-null and would over-filter late-entry columns the same way. The matrix
 * still evaluates them but expect collapsing n at later entry times.
 */

import type Database from 'better-sqlite3';
import {
  FILTER_CATALOG,
  computeBestCombos,
  simulateCombo,
  whereForFilterNames,
  type SimulateComboResult,
} from './aggregates';

/** Entry checkpoints to sweep. All map to existing graduation_momentum columns
 *  (pct_t30 is the default, pct_t60/90/120 are 5s-grid columns, pct_t180/240
 *  are also 5s-grid columns since SIM_CHECKPOINT_COLUMNS goes T+40..T+300 in
 *  step-5). Add to this list freely — every entry checkpoint must be a
 *  multiple of 5 between 5 and 300 to map to a real column. */
const ENTRY_TIMES_SEC = [30, 60, 90, 120, 180, 240] as const;

/** Minimum n per cell before a cell's opt_* values are taken at face value.
 *  Mirrors SIM_MIN_N_FOR_OPTIMUM in sim-constants.ts. Cells under this bar
 *  still report their numerics but `low_n: true` so the analyst knows. */
const MIN_N_PER_CELL = 30;

/** Minimum n for picking `best_entry_sec` — we don't want a 12-row T+240 cell
 *  with a fluke +50% beating a robust 200-row T+30 cell. If no cell clears
 *  this bar, best_entry_sec falls back to null and the row is annotated. */
const MIN_N_FOR_BEST_PICK = 50;

/** Top-N combos pulled from /api/best-combos to seed the matrix. Plus all
 *  single filters from FILTER_CATALOG. */
const TOP_COMBOS_FROM_LEADERBOARD = 30;

export interface EntryTimeCell {
  entry_sec: number;
  n: number;
  pump: number;
  /** Raw entry→T+300 buy-and-hold return (cost-adjusted via slippage column). */
  raw_avg_ret: number | null;
  opt_tp: number | null;
  opt_sl: number | null;
  opt_avg_ret: number | null;
  opt_win_rate: number | null;
  /** True when n < MIN_N_PER_CELL — values reported but unreliable. */
  low_n: boolean;
}

export interface EntryTimeMatrixRow {
  filter_spec: string;
  filters: string[];
  /** Type of candidate row — single FILTER_CATALOG entry, leaderboard pair, or all-rows baseline. */
  source: 'baseline' | 'single' | 'pair';
  by_entry_time: EntryTimeCell[];
  /** Entry second with the highest opt_avg_ret among cells with n >= MIN_N_FOR_BEST_PICK.
   *  Null when no cell qualifies. */
  best_entry_sec: number | null;
  best_opt_avg_ret: number | null;
  /** Δ in pp between best_opt_avg_ret and the T+30 cell's opt_avg_ret. Null when either is null. */
  delta_vs_t30_pp: number | null;
}

export interface EntryTimeMatrixSummary {
  /** Among rows where best_entry_sec is non-null, count by entry-second. */
  best_entry_sec_distribution: Record<number, number>;
  /** Mean Δ vs T+30 across all rows where both endpoints have n >= MIN_N_FOR_BEST_PICK. */
  mean_delta_vs_t30_pp: number | null;
  /** % of qualifying rows where any non-T+30 entry beats T+30 by ≥ +0.3 pp. */
  pct_rows_late_entry_beats_t30: number | null;
  /** Per-filter-group breakdown: which entry second wins most often within each group. */
  by_group: Array<{
    group: string;
    best_entry_sec: number | null;
    n_rows: number;
  }>;
  notes: string[];
}

export interface EntryTimeMatrixData {
  generated_at: string;
  entry_times_sec: number[];
  min_n_per_cell: number;
  min_n_for_best_pick: number;
  rows: EntryTimeMatrixRow[];
  summary: EntryTimeMatrixSummary;
}

/** Run simulateCombo at every entry-time checkpoint and shape the result row. */
function buildRow(
  db: Database.Database,
  filter_spec: string,
  filters: string[],
  source: EntryTimeMatrixRow['source'],
  whereClause: string,
): EntryTimeMatrixRow {
  const cells: EntryTimeCell[] = [];
  for (const sec of ENTRY_TIMES_SEC) {
    const r: SimulateComboResult = simulateCombo(db, whereClause, sec);
    cells.push({
      entry_sec: sec,
      n: r.n,
      pump: r.pump,
      raw_avg_ret: r.avg_return_t30_to_t300_pct,
      opt_tp: r.opt_tp,
      opt_sl: r.opt_sl,
      opt_avg_ret: r.opt_avg_ret,
      opt_win_rate: r.opt_win_rate,
      low_n: r.n < MIN_N_PER_CELL,
    });
  }

  // Pick best_entry_sec only among cells that clear MIN_N_FOR_BEST_PICK.
  let best: EntryTimeCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST_PICK) continue;
    if (c.opt_avg_ret == null) continue;
    if (best == null || c.opt_avg_ret > (best.opt_avg_ret as number)) best = c;
  }
  const t30Cell = cells.find(c => c.entry_sec === 30) ?? null;
  const delta =
    best && t30Cell && best.opt_avg_ret != null && t30Cell.opt_avg_ret != null
      ? +(best.opt_avg_ret - t30Cell.opt_avg_ret).toFixed(2)
      : null;

  return {
    filter_spec,
    filters,
    source,
    by_entry_time: cells,
    best_entry_sec: best?.entry_sec ?? null,
    best_opt_avg_ret: best?.opt_avg_ret ?? null,
    delta_vs_t30_pp: delta,
  };
}

export function computeEntryTimeMatrix(db: Database.Database): EntryTimeMatrixData {
  const rows: EntryTimeMatrixRow[] = [];

  // 1. Rolling baseline — every entry-gated labeled row, no extra filter.
  rows.push(buildRow(db, 'ALL (entry-gated)', [], 'baseline', '1=1'));

  // 2. Single filters — every catalog entry. Cheap (n_filters * n_entry_times
  //    simulateCombo calls — each call is one SELECT + a 120-cell grid walk).
  for (const f of FILTER_CATALOG) {
    rows.push(buildRow(db, f.name, [f.name], 'single', f.where));
  }

  // 3. Top combos from the standard leaderboard. Use opt-ranked output so we
  //    explore the same population the user already sees on /api/best-combos.
  const lb = computeBestCombos(db, {
    min_n: 30,
    top: TOP_COMBOS_FROM_LEADERBOARD,
    include_pairs: true,
  });
  // Skip rows already covered as singles to avoid duplicates.
  const singlesSeen = new Set(FILTER_CATALOG.map(f => f.name));
  for (const c of lb.rows) {
    if (c.filters.length < 2) continue;
    const where = whereForFilterNames(c.filters);
    if (!where) continue;
    if (singlesSeen.has(c.filter_spec)) continue;
    rows.push(buildRow(db, c.filter_spec, c.filters, 'pair', where));
  }

  // ── Summary stats ──
  const distribution: Record<number, number> = {};
  for (const sec of ENTRY_TIMES_SEC) distribution[sec] = 0;
  let qualifyingRows = 0;
  let lateEntryBeats = 0;
  let deltaSum = 0;
  let deltaN = 0;

  for (const r of rows) {
    if (r.best_entry_sec != null) distribution[r.best_entry_sec]++;
    if (r.delta_vs_t30_pp != null) {
      qualifyingRows++;
      deltaSum += r.delta_vs_t30_pp;
      deltaN++;
      if (r.delta_vs_t30_pp >= 0.3 && r.best_entry_sec !== 30) lateEntryBeats++;
    }
  }

  // Group breakdown — only over `single` rows since those have a clean group.
  const groupMap: Record<string, Record<number, number>> = {};
  for (const f of FILTER_CATALOG) {
    if (!groupMap[f.group]) {
      const init: Record<number, number> = {};
      for (const sec of ENTRY_TIMES_SEC) init[sec] = 0;
      groupMap[f.group] = init;
    }
  }
  for (const r of rows) {
    if (r.source !== 'single') continue;
    const f = FILTER_CATALOG.find(x => x.name === r.filter_spec);
    if (!f) continue;
    if (r.best_entry_sec == null) continue;
    groupMap[f.group][r.best_entry_sec]++;
  }
  const byGroup: EntryTimeMatrixSummary['by_group'] = [];
  for (const [group, counts] of Object.entries(groupMap)) {
    let best: number | null = null;
    let bestCount = 0;
    let totalRows = 0;
    for (const sec of ENTRY_TIMES_SEC) {
      totalRows += counts[sec];
      if (counts[sec] > bestCount) { bestCount = counts[sec]; best = sec; }
    }
    byGroup.push({ group, best_entry_sec: totalRows > 0 ? best : null, n_rows: totalRows });
  }
  byGroup.sort((a, b) => b.n_rows - a.n_rows);

  const notes: string[] = [
    `Each cell evaluates simulateCombo() with the entry anchored on pct_t<entry_sec>; SL/TP grid (12×10) walks checkpoints strictly after that second. Default entry_sec=30 reproduces /api/best-combos exactly.`,
    `Sample sizes shrink at later entries because pct_t60/90/120/180/240 are NULL on observations that arrived after that checkpoint (15.6% full-5s-grid coverage as of 2026-05-02). Compare cells against each other only when both have n >= ${MIN_N_FOR_BEST_PICK}.`,
    `delta_vs_t30_pp uses opt_avg_ret at the row's best_entry_sec minus opt_avg_ret at T+30. Positive Δ on a high-n combo is the signal you're hunting — that's a candidate for a late-entry shadow strategy.`,
    `Path-shape filters (mono_*, dd_*, accel_*) require pct_t5..pct_t30 to be non-null already, so their populations don't shrink further at late entries — but they still need pct_t<entry_sec> to be populated, which is the binding constraint.`,
  ];

  // Sort rows: baseline first, then by best |delta_vs_t30_pp| desc among
  // qualifying rows, then by n_at_best desc as tie-breaker. Null deltas drop.
  rows.sort((a, b) => {
    if (a.source === 'baseline') return -1;
    if (b.source === 'baseline') return 1;
    const ad = a.delta_vs_t30_pp;
    const bd = b.delta_vs_t30_pp;
    if (ad == null && bd == null) return 0;
    if (ad == null) return 1;
    if (bd == null) return -1;
    return bd - ad;
  });

  return {
    generated_at: new Date().toISOString(),
    entry_times_sec: [...ENTRY_TIMES_SEC],
    min_n_per_cell: MIN_N_PER_CELL,
    min_n_for_best_pick: MIN_N_FOR_BEST_PICK,
    rows,
    summary: {
      best_entry_sec_distribution: distribution,
      mean_delta_vs_t30_pp: deltaN > 0 ? +(deltaSum / deltaN).toFixed(2) : null,
      pct_rows_late_entry_beats_t30:
        qualifyingRows > 0 ? +(lateEntryBeats / qualifyingRows * 100).toFixed(1) : null,
      by_group: byGroup,
      notes,
    },
  };
}
