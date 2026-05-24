/**
 * src/api/price-path-v2-data.ts
 *
 * Compute payload for /price-path-v2 — the "winner-vs-loser feature
 * investigator". Panels 1-4 of the research synthesis:
 *
 *   Panel 1  Cohort definitions (selector metadata)
 *   Panel 2  All-feature importance ranking
 *   Panel 3  Univariate distribution comparator
 *   Panel 4  Curated bivariate heatmaps
 *
 * Two cohort definitions ship in every payload:
 *   COHORT_A  top decile vs bottom decile of `max_peak_pct`
 *             (always-populated outcome → maximal n)
 *   COHORT_B  top decile vs bottom decile of SUM(net_profit_sol per
 *             graduation_id), cross-strategy, closed unarchived trades only
 *
 * Each cohort ships in two variants: `full` and `drop_top3`. The drop_top3
 * variant strips the 3 max-outcome rows from the eligible set BEFORE
 * percentile cuts — directly mirrors the leave-one-out lottery-ticket check
 * that CLAUDE.md's promotion bar relies on (`total_net_sol_drop_top3 > 0`).
 *
 * Hard correctness rules:
 *   - Predictors are restricted to PREDICTOR_WHITELIST (T+30-safe).
 *     Anything post-T+30 (pct_t60+, max_relret_*, max_peak_*, label*) is
 *     OUTCOME-only and MUST NOT appear as a predictor. See
 *     price-path-v2-predictors.ts.
 *   - Cohen's d is SIGNED (winner_mean - loser_mean) / pooled_sd, so a
 *     positive d means "winners have higher values of this feature."
 *   - `low_confidence: true` flags rows where either side has n<30 — Cohen's
 *     d on small n is too noisy to trust.
 */

import type Database from 'better-sqlite3';
import { PREDICTOR_WHITELIST, BIVARIATE_PAIRS, type PredictorDef, type CoverageClass } from './price-path-v2-predictors';

// ── Types ────────────────────────────────────────────────────────────────

export interface PricePathV2Data {
  generated_at: string;
  cohort_definitions: CohortDefinitionsPanel;
  feature_importance: FeatureImportanceSection;
  distributions: DistributionsSection;
  heatmaps: HeatmapsSection;
  notes: string[];
}

export interface CohortDefinitionsPanel {
  cohort_a: CohortMeta;
  cohort_b: CohortMeta;
  generated_at: string;
}

export interface CohortMeta {
  name: 'A_peak_return' | 'B_realized_pnl';
  description: string;
  outcome_field: string;
  total_rows_considered: number;
  rows_with_outcome: number;
  outcome_coverage_pct: number;
  winner_threshold: number | null;
  loser_threshold: number | null;
  winner_n: number;
  loser_n: number;
  winner_n_drop_top3: number;
  drop_top3_mints: string[];
  notes: string[];
}

export interface FeatureImportanceSection {
  cohort_a: { full: FeatureImportancePanel; drop_top3: FeatureImportancePanel };
  cohort_b: { full: FeatureImportancePanel; drop_top3: FeatureImportancePanel };
}

export interface FeatureImportancePanel {
  rows: FeatureImportanceRow[];
}

export interface FeatureImportanceRow {
  col: string;
  display: string;
  units: string;
  coverage: CoverageClass;
  direction_hint?: 'higher_is_better' | 'lower_is_better' | 'unknown';
  cohens_d: number | null;
  abs_cohens_d: number | null;
  ks_statistic: number | null;
  point_biserial_r: number | null;
  winner_n_with_data: number;
  loser_n_with_data: number;
  winner_median: number | null;
  loser_median: number | null;
  winner_mean: number | null;
  loser_mean: number | null;
  top_quartile_winner_rate: number | null;
  bottom_quartile_winner_rate: number | null;
  top_quartile_wilson_ci: [number, number] | null;
  bottom_quartile_wilson_ci: [number, number] | null;
  low_confidence: boolean;
  note: string | null;
}

export interface DistributionsSection {
  cohort_a: { full: DistributionPanel; drop_top3: DistributionPanel };
  cohort_b: { full: DistributionPanel; drop_top3: DistributionPanel };
}

export interface DistributionPanel {
  by_feature: Record<string, DistributionFeature>;
}

export interface DistributionFeature {
  col: string;
  display: string;
  units: string;
  bin_count: number;
  bin_min: number;
  bin_max: number;
  bin_edges: number[];
  winner_bins: number[];
  loser_bins: number[];
  winner_n: number;
  loser_n: number;
  winner_median: number | null;
  loser_median: number | null;
  winner_mean: number | null;
  loser_mean: number | null;
  cohens_d: number | null;
  truncation_note: string | null;
}

export interface HeatmapsSection {
  cohort_a: { full: HeatmapPanel; drop_top3: HeatmapPanel };
  cohort_b: { full: HeatmapPanel; drop_top3: HeatmapPanel };
}

export interface HeatmapPanel {
  pairs: BivariateHeatmap[];
}

export interface BivariateHeatmap {
  x_col: string;
  y_col: string;
  x_display: string;
  y_display: string;
  grid_size: number;
  x_edges: number[];
  y_edges: number[];
  cells: HeatmapCell[];
  n_total: number;
  n_dropped_no_data: number;
}

export interface HeatmapCell {
  ix: number;
  iy: number;
  n_count: number;
  mean_outcome: number | null;
}

// Internal row shape after the base SQL load
interface BaseRow {
  graduation_id: number;
  mint: string;
  max_peak_pct: number;
  realized_net_sol: number | null; // populated by the trades aggregate merge
  trade_count: number;             // 0 when no trades for this graduation
  // every PREDICTOR_WHITELIST column lives on this object as col → number | null
  [feature: string]: number | string | null;
}

// ── Stat primitives ──────────────────────────────────────────────────────

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  let s = 0;
  for (const v of vals) s += v;
  return s / vals.length;
}

function median(sortedVals: number[]): number | null {
  if (sortedVals.length === 0) return null;
  const mid = Math.floor(sortedVals.length / 2);
  return sortedVals.length % 2 === 0
    ? (sortedVals[mid - 1] + sortedVals[mid]) / 2
    : sortedVals[mid];
}

function stdev(vals: number[], m?: number): number {
  if (vals.length < 2) return 0;
  const mu = m ?? mean(vals);
  let s = 0;
  for (const v of vals) s += (v - mu) ** 2;
  return Math.sqrt(s / vals.length);
}

/** Signed Cohen's d: (mean_a - mean_b) / pooled_sd. */
function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const ma = mean(a);
  const mb = mean(b);
  const sa = stdev(a, ma);
  const sb = stdev(b, mb);
  const pooled = Math.sqrt((sa ** 2 + sb ** 2) / 2);
  if (pooled === 0) return null;
  return +((ma - mb) / pooled).toFixed(4);
}

/** KS two-sample statistic (max |F_a(x) - F_b(x)|). O(n_a + n_b) merge-walk. */
function ksStatistic(a: number[], b: number[]): number | null {
  if (a.length < 5 || b.length < 5) return null;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  const na = sa.length;
  const nb = sb.length;
  // Merge-walk: at each step, the next "x" to evaluate is the smaller of
  // sa[i] / sb[j]. Both i and j advance past every value <= x. The outer loop
  // does at most na+nb iterations because each iteration consumes at least
  // one element. Total work O(na + nb).
  let i = 0;
  let j = 0;
  let maxDiff = 0;
  while (i < na || j < nb) {
    let x: number;
    if (i >= na) x = sb[j];
    else if (j >= nb) x = sa[i];
    else x = sa[i] <= sb[j] ? sa[i] : sb[j];
    while (i < na && sa[i] <= x) i++;
    while (j < nb && sb[j] <= x) j++;
    const diff = Math.abs(i / na - j / nb);
    if (diff > maxDiff) maxDiff = diff;
  }
  return +maxDiff.toFixed(4);
}

/** Point-biserial correlation between continuous values and a binary flag. */
function pointBiserialR(values: number[], flags: number[]): number | null {
  if (values.length !== flags.length || values.length < 4) return null;
  let n1 = 0;
  let n0 = 0;
  let sum1 = 0;
  let sum0 = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === 1) { n1++; sum1 += values[i]; } else { n0++; sum0 += values[i]; }
  }
  if (n1 < 2 || n0 < 2) return null;
  const m1 = sum1 / n1;
  const m0 = sum0 / n0;
  const s = stdev(values);
  if (s === 0) return null;
  const n = values.length;
  return +((m1 - m0) / s * Math.sqrt((n1 * n0) / (n * n))).toFixed(4);
}

/** Wilson 95% confidence interval for a binomial proportion. */
function wilsonInterval(successes: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z ** 2) / n;
  const centre = (p + (z ** 2) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * n)) / n)) / denom;
  return [+(centre - half).toFixed(4), +(centre + half).toFixed(4)];
}

function percentile(sortedVals: number[], p: number): number | null {
  if (sortedVals.length === 0) return null;
  if (p <= 0) return sortedVals[0];
  if (p >= 1) return sortedVals[sortedVals.length - 1];
  const idx = (sortedVals.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedVals[lo];
  const frac = idx - lo;
  return sortedVals[lo] * (1 - frac) + sortedVals[hi] * frac;
}

function histogram(values: number[], edges: number[]): number[] {
  const n = edges.length - 1;
  const bins = new Array(n).fill(0);
  for (const v of values) {
    if (v < edges[0] || v > edges[n]) continue;
    // last bin is right-inclusive
    let idx = Math.floor(((v - edges[0]) / (edges[n] - edges[0])) * n);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  return bins;
}

function quartileEdges(sortedVals: number[], k: number): number[] | null {
  if (sortedVals.length < k + 1) return null;
  const edges = [sortedVals[0]];
  for (let i = 1; i < k; i++) {
    const v = percentile(sortedVals, i / k);
    if (v === null) return null;
    edges.push(v);
  }
  edges.push(sortedVals[sortedVals.length - 1]);
  // Dedupe collapsed edges (heavy ties): if any consecutive pair equal, bail.
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] === edges[i - 1]) return null;
  }
  return edges;
}

function getNum(row: BaseRow, col: string): number | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function collectFeature(rows: BaseRow[], col: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = getNum(r, col);
    if (v !== null) out.push(v);
  }
  return out;
}

// ── SQL load ─────────────────────────────────────────────────────────────

function loadBaseRows(db: Database.Database): BaseRow[] {
  const predictorCols = PREDICTOR_WHITELIST.map(p => `gm.${p.col}`).join(',\n    ');
  const sql = `
    SELECT
      gm.graduation_id AS graduation_id,
      g.mint           AS mint,
      gm.max_peak_pct  AS max_peak_pct,
      ${predictorCols}
    FROM graduation_momentum gm
    JOIN graduations g ON g.id = gm.graduation_id
    WHERE gm.max_peak_pct IS NOT NULL
      AND gm.pct_t300 IS NOT NULL
  `;
  const rawRows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  return rawRows.map(r => {
    const out: BaseRow = {
      graduation_id: r.graduation_id as number,
      mint: r.mint as string,
      max_peak_pct: r.max_peak_pct as number,
      realized_net_sol: null,
      trade_count: 0,
    };
    for (const p of PREDICTOR_WHITELIST) {
      const v = r[p.col];
      out[p.col] = (v === null || v === undefined) ? null : (v as number);
    }
    return out;
  });
}

function loadRealizedPnl(db: Database.Database): Map<number, { sum: number; count: number }> {
  const sql = `
    SELECT
      graduation_id,
      SUM(net_profit_sol) AS realized_net_sol_sum,
      COUNT(*)            AS trade_count
    FROM trades_v2
    WHERE status = 'closed'
      AND (archived IS NULL OR archived = 0)
      AND net_profit_sol IS NOT NULL
    GROUP BY graduation_id
  `;
  const rows = db.prepare(sql).all() as Array<{ graduation_id: number; realized_net_sol_sum: number; trade_count: number }>;
  const m = new Map<number, { sum: number; count: number }>();
  for (const r of rows) {
    m.set(r.graduation_id, { sum: r.realized_net_sol_sum, count: r.trade_count });
  }
  return m;
}

// ── Cohort building ──────────────────────────────────────────────────────

interface CohortResult {
  winners: BaseRow[];
  losers: BaseRow[];
  meta: CohortMeta;
}

function buildCohort(
  rows: BaseRow[],
  outcomeField: string,
  cohortName: 'A_peak_return' | 'B_realized_pnl',
  description: string,
  dropTop3: boolean,
  totalRowsConsidered: number,
): CohortResult {
  // Eligible = has a numeric outcome
  const eligible = rows.filter(r => {
    const v = getNum(r, outcomeField);
    return v !== null;
  });
  // Sort by outcome ascending
  eligible.sort((a, b) => (getNum(a, outcomeField) as number) - (getNum(b, outcomeField) as number));

  // Optionally strip top 3 by outcome from the eligible set
  let workingSet = eligible;
  const droppedMints: string[] = [];
  if (dropTop3 && eligible.length > 3) {
    const dropped = eligible.slice(eligible.length - 3);
    for (const r of dropped) droppedMints.push(r.mint);
    workingSet = eligible.slice(0, eligible.length - 3);
  }

  const outcomes = workingSet.map(r => getNum(r, outcomeField) as number);
  const p10 = percentile(outcomes, 0.10);
  const p90 = percentile(outcomes, 0.90);

  const winners: BaseRow[] = [];
  const losers: BaseRow[] = [];
  if (p10 !== null && p90 !== null && workingSet.length > 0) {
    for (const r of workingSet) {
      const v = getNum(r, outcomeField) as number;
      if (v >= p90) winners.push(r);
      if (v <= p10) losers.push(r);
    }
  }

  const eligibleN = eligible.length;
  const meta: CohortMeta = {
    name: cohortName,
    description,
    outcome_field: outcomeField,
    total_rows_considered: totalRowsConsidered,
    rows_with_outcome: eligibleN,
    outcome_coverage_pct: totalRowsConsidered === 0 ? 0 : +(eligibleN / totalRowsConsidered * 100).toFixed(2),
    winner_threshold: p90 === null ? null : +p90.toFixed(4),
    loser_threshold: p10 === null ? null : +p10.toFixed(4),
    winner_n: winners.length,
    loser_n: losers.length,
    winner_n_drop_top3: dropTop3 ? winners.length : Math.max(0, winners.length - 3),
    drop_top3_mints: droppedMints,
    notes: dropTop3
      ? ['drop_top3 variant: top 3 max-outcome rows stripped from the eligible set BEFORE percentile cuts']
      : [],
  };

  return { winners, losers, meta };
}

// ── Panel 2: feature importance ──────────────────────────────────────────

function computeFeatureImportance(winners: BaseRow[], losers: BaseRow[]): FeatureImportancePanel {
  const rows: FeatureImportanceRow[] = [];
  const winnerN = winners.length;
  const loserN = losers.length;

  for (const p of PREDICTOR_WHITELIST) {
    const winVals = collectFeature(winners, p.col);
    const losVals = collectFeature(losers, p.col);
    const winSorted = [...winVals].sort((a, b) => a - b);
    const losSorted = [...losVals].sort((a, b) => a - b);

    const d = cohensD(winVals, losVals);
    const ks = ksStatistic(winVals, losVals);

    // point-biserial r: pool winner/loser values with a 0/1 winner-flag
    const pbValues: number[] = [];
    const pbFlags: number[] = [];
    for (const v of winVals) { pbValues.push(v); pbFlags.push(1); }
    for (const v of losVals) { pbValues.push(v); pbFlags.push(0); }
    const pb = pointBiserialR(pbValues, pbFlags);

    // Quartile-of-feature winner-rate: pool both cohorts, take top/bottom Q,
    // measure fraction-that-are-winners within each.
    let topQWR: number | null = null;
    let botQWR: number | null = null;
    let topQCI: [number, number] | null = null;
    let botQCI: [number, number] | null = null;
    if (winVals.length + losVals.length >= 20) {
      const pooled: Array<{ v: number; isWin: 0 | 1 }> = [];
      for (const v of winVals) pooled.push({ v, isWin: 1 });
      for (const v of losVals) pooled.push({ v, isWin: 0 });
      pooled.sort((a, b) => a.v - b.v);
      const qSize = Math.floor(pooled.length / 4);
      if (qSize > 0) {
        const bot = pooled.slice(0, qSize);
        const top = pooled.slice(pooled.length - qSize);
        const botWins = bot.filter(x => x.isWin === 1).length;
        const topWins = top.filter(x => x.isWin === 1).length;
        botQWR = +(botWins / bot.length).toFixed(4);
        topQWR = +(topWins / top.length).toFixed(4);
        botQCI = wilsonInterval(botWins, bot.length);
        topQCI = wilsonInterval(topWins, top.length);
      }
    }

    const lowConfidence = winVals.length < 30 || losVals.length < 30;
    const note = p.coverage === 'new-only' && (winVals.length < winnerN || losVals.length < loserN)
      ? `Coverage gap: only ${winVals.length}/${winnerN} winners and ${losVals.length}/${loserN} losers have this field populated (new-only column — historical rows have NULL).`
      : null;

    rows.push({
      col: p.col,
      display: p.display,
      units: p.units,
      coverage: p.coverage,
      direction_hint: p.direction_hint,
      cohens_d: d,
      abs_cohens_d: d === null ? null : +Math.abs(d).toFixed(4),
      ks_statistic: ks,
      point_biserial_r: pb,
      winner_n_with_data: winVals.length,
      loser_n_with_data: losVals.length,
      winner_median: median(winSorted),
      loser_median: median(losSorted),
      winner_mean: winVals.length === 0 ? null : +mean(winVals).toFixed(4),
      loser_mean: losVals.length === 0 ? null : +mean(losVals).toFixed(4),
      top_quartile_winner_rate: topQWR,
      bottom_quartile_winner_rate: botQWR,
      top_quartile_wilson_ci: topQCI,
      bottom_quartile_wilson_ci: botQCI,
      low_confidence: lowConfidence,
      note,
    });
  }

  // Sort by |Cohen's d| descending; nulls last
  rows.sort((a, b) => {
    const aD = a.abs_cohens_d ?? -1;
    const bD = b.abs_cohens_d ?? -1;
    return bD - aD;
  });
  return { rows };
}

// ── Panel 3: distributions ───────────────────────────────────────────────

function computeDistributions(winners: BaseRow[], losers: BaseRow[]): DistributionPanel {
  const BIN_COUNT = 30;
  const byFeature: Record<string, DistributionFeature> = {};

  for (const p of PREDICTOR_WHITELIST) {
    const winVals = collectFeature(winners, p.col);
    const losVals = collectFeature(losers, p.col);
    if (winVals.length === 0 && losVals.length === 0) continue;

    const all = [...winVals, ...losVals];
    if (all.length < 2) continue;
    const sorted = [...all].sort((a, b) => a - b);
    // Clip at P1-P99 to keep heavy-tail outliers from collapsing the bins.
    let lo = percentile(sorted, 0.01) ?? sorted[0];
    let hi = percentile(sorted, 0.99) ?? sorted[sorted.length - 1];
    let truncationNote: string | null = null;
    if (lo === hi) { lo = sorted[0]; hi = sorted[sorted.length - 1]; }
    if (lo === hi) continue; // all values identical — nothing to bin
    const minRaw = sorted[0];
    const maxRaw = sorted[sorted.length - 1];
    if (lo > minRaw || hi < maxRaw) {
      truncationNote = `Bin range clipped at P1=${lo.toFixed(3)} / P99=${hi.toFixed(3)} (raw range ${minRaw.toFixed(3)}..${maxRaw.toFixed(3)}); out-of-range values dropped from histogram.`;
    }
    const step = (hi - lo) / BIN_COUNT;
    const edges: number[] = [];
    for (let i = 0; i <= BIN_COUNT; i++) edges.push(+(lo + i * step).toFixed(6));

    const winSorted = [...winVals].sort((a, b) => a - b);
    const losSorted = [...losVals].sort((a, b) => a - b);

    byFeature[p.col] = {
      col: p.col,
      display: p.display,
      units: p.units,
      bin_count: BIN_COUNT,
      bin_min: +lo.toFixed(6),
      bin_max: +hi.toFixed(6),
      bin_edges: edges,
      winner_bins: histogram(winVals, edges),
      loser_bins: histogram(losVals, edges),
      winner_n: winVals.length,
      loser_n: losVals.length,
      winner_median: median(winSorted),
      loser_median: median(losSorted),
      winner_mean: winVals.length === 0 ? null : +mean(winVals).toFixed(4),
      loser_mean: losVals.length === 0 ? null : +mean(losVals).toFixed(4),
      cohens_d: cohensD(winVals, losVals),
      truncation_note: truncationNote,
    };
  }

  return { by_feature: byFeature };
}

// ── Panel 4: heatmaps ────────────────────────────────────────────────────

function computeHeatmaps(
  winners: BaseRow[],
  losers: BaseRow[],
  outcomeField: string,
): HeatmapPanel {
  const GRID = 6;
  const pool = [...winners, ...losers];
  const predDisplay = new Map(PREDICTOR_WHITELIST.map(p => [p.col, p.display]));
  const pairs: BivariateHeatmap[] = [];

  for (const [xCol, yCol] of BIVARIATE_PAIRS) {
    // Collect rows where BOTH axes + outcome are populated
    const cells: Array<{ x: number; y: number; outcome: number }> = [];
    let dropped = 0;
    for (const r of pool) {
      const x = getNum(r, xCol);
      const y = getNum(r, yCol);
      const o = getNum(r, outcomeField);
      if (x === null || y === null || o === null) { dropped++; continue; }
      cells.push({ x, y, outcome: o });
    }
    if (cells.length < GRID * 2) continue;

    const xs = cells.map(c => c.x).sort((a, b) => a - b);
    const ys = cells.map(c => c.y).sort((a, b) => a - b);
    const xEdges = quartileEdges(xs, GRID);
    const yEdges = quartileEdges(ys, GRID);
    if (!xEdges || !yEdges) continue;

    const grid: HeatmapCell[] = [];
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        grid.push({ ix, iy, n_count: 0, mean_outcome: null });
      }
    }
    const sums = new Array(GRID * GRID).fill(0);
    for (const c of cells) {
      let ix = 0;
      while (ix < GRID && c.x > xEdges[ix + 1]) ix++;
      if (ix >= GRID) ix = GRID - 1;
      let iy = 0;
      while (iy < GRID && c.y > yEdges[iy + 1]) iy++;
      if (iy >= GRID) iy = GRID - 1;
      const idx = iy * GRID + ix;
      grid[idx].n_count++;
      sums[idx] += c.outcome;
    }
    for (let i = 0; i < grid.length; i++) {
      if (grid[i].n_count > 0) grid[i].mean_outcome = +(sums[i] / grid[i].n_count).toFixed(4);
    }

    pairs.push({
      x_col: xCol,
      y_col: yCol,
      x_display: predDisplay.get(xCol) ?? xCol,
      y_display: predDisplay.get(yCol) ?? yCol,
      grid_size: GRID,
      x_edges: xEdges.map(v => +v.toFixed(4)),
      y_edges: yEdges.map(v => +v.toFixed(4)),
      cells: grid,
      n_total: cells.length,
      n_dropped_no_data: dropped,
    });
  }

  return { pairs };
}

// ── Entry point ──────────────────────────────────────────────────────────

export function computePricePathV2Data(db: Database.Database): PricePathV2Data {
  const generatedAt = new Date().toISOString();
  const baseRows = loadBaseRows(db);

  // Merge realized PnL onto base rows
  const pnlMap = loadRealizedPnl(db);
  for (const r of baseRows) {
    const hit = pnlMap.get(r.graduation_id);
    if (hit) {
      r.realized_net_sol = hit.sum;
      r.trade_count = hit.count;
    }
  }

  const totalRows = baseRows.length;

  const aFull = buildCohort(
    baseRows, 'max_peak_pct', 'A_peak_return',
    'Top decile vs bottom decile of max_peak_pct (always-populated outcome).',
    false, totalRows,
  );
  const aDrop = buildCohort(
    baseRows, 'max_peak_pct', 'A_peak_return',
    'Top decile vs bottom decile of max_peak_pct (always-populated outcome).',
    true, totalRows,
  );

  // Cohort B only considers rows with a trade (realized_net_sol non-null)
  const tradedRows = baseRows.filter(r => r.realized_net_sol !== null);
  const bFull = buildCohort(
    tradedRows, 'realized_net_sol', 'B_realized_pnl',
    'Top decile vs bottom decile of SUM(net_profit_sol per graduation), cross-strategy, closed unarchived trades only.',
    false, totalRows,
  );
  const bDrop = buildCohort(
    tradedRows, 'realized_net_sol', 'B_realized_pnl',
    'Top decile vs bottom decile of SUM(net_profit_sol per graduation), cross-strategy, closed unarchived trades only.',
    true, totalRows,
  );

  const data: PricePathV2Data = {
    generated_at: generatedAt,
    cohort_definitions: {
      cohort_a: aFull.meta,
      cohort_b: bFull.meta,
      generated_at: generatedAt,
    },
    feature_importance: {
      cohort_a: {
        full: computeFeatureImportance(aFull.winners, aFull.losers),
        drop_top3: computeFeatureImportance(aDrop.winners, aDrop.losers),
      },
      cohort_b: {
        full: computeFeatureImportance(bFull.winners, bFull.losers),
        drop_top3: computeFeatureImportance(bDrop.winners, bDrop.losers),
      },
    },
    distributions: {
      cohort_a: {
        full: computeDistributions(aFull.winners, aFull.losers),
        drop_top3: computeDistributions(aDrop.winners, aDrop.losers),
      },
      cohort_b: {
        full: computeDistributions(bFull.winners, bFull.losers),
        drop_top3: computeDistributions(bDrop.winners, bDrop.losers),
      },
    },
    heatmaps: {
      cohort_a: {
        full: computeHeatmaps(aFull.winners, aFull.losers, 'max_peak_pct'),
        drop_top3: computeHeatmaps(aDrop.winners, aDrop.losers, 'max_peak_pct'),
      },
      cohort_b: {
        full: computeHeatmaps(bFull.winners, bFull.losers, 'realized_net_sol'),
        drop_top3: computeHeatmaps(bDrop.winners, bDrop.losers, 'realized_net_sol'),
      },
    },
    notes: [
      'Cohort A = top decile vs bottom decile of max_peak_pct (always-populated outcome).',
      'Cohort B = top decile vs bottom decile of SUM(trades_v2.net_profit_sol per graduation_id), LEFT JOIN — only graduations with trade_count>0 are eligible. Cross-strategy: aggregates over every closed unarchived trade for the token, regardless of strategy_id.',
      'drop_top3 variant strips the 3 max-outcome rows from the eligible set BEFORE percentile cuts — same lottery-ticket robustness check as leave-one-out-pnl.json.',
      "Predictors are restricted to PREDICTOR_WHITELIST (T+30-safe). Outcome-only fields (pct_t60+, max_peak_*, max_relret_*, label*) are intentionally excluded — using them as predictors would be a look-ahead leak.",
      "Cohen's d is SIGNED: positive = winners have higher values; negative = winners have lower values.",
      'low_confidence=true when either cohort side has n<30 for that feature — small-n Cohen\'s d is too noisy to act on.',
      "Coverage classes: 'always' (full historical coverage), 'auto-backfill' (backfilled at boot via bot_settings markers — safe on historical), 'new-only' (permanent NULL on pre-rollout rows; see winner_n_with_data vs winner_n for the gap).",
      'Heatmap cell mean_outcome = mean(max_peak_pct) for cohort A, mean(realized_net_sol) for cohort B.',
      'Histograms clip the value range at P1-P99 to keep heavy-tail outliers from collapsing the bins; see per-feature truncation_note.',
    ],
  };

  return data;
}
