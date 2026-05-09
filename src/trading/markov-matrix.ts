/**
 * src/trading/markov-matrix.ts
 *
 * State-conditional exit DPM.
 *
 * Build: scan graduation_momentum for rows that pass a strategy's filter set
 * and entry gate, then for each historical path compute relret_N_from_30 at
 * every available checkpoint N ∈ [35..240]. Bucket relret_N values into 7 bins,
 * count how many of those paths ended profitable (relret_300_from_30 > 0).
 * The result is `P(profit at T+300 | filter, age=N, current bucket)`.
 *
 * Live: at every 5s position tick, the position-manager looks up
 *   matrix[filter_key][nearest_checkpoint][bucket(cur_pct_from_entry)]
 * If P(profit) < exitThreshold AND cell is well-sampled → exit early.
 * If P(profit) > holdThreshold AND we'd otherwise hit a hard TP → keep holding.
 *
 * Refit: re-scan from scratch every REFIT_PATHS_THRESHOLD newly-labeled paths
 * (default 50). Cheap on n≤a few thousand rows.
 */

import type Database from 'better-sqlite3';
import { FilterConfig } from './config';

// ── Tunables ────────────────────────────────────────────────────────────────

/** Bin boundaries for relret_from_entry (in pct). 6 boundaries → 7 bins:
 *  [<-30, -30..-15, -15..-5, -5..+5, +5..+15, +15..+35, >+35].
 *  Chosen to span the typical observed range — DUMP paths sit in the bottom
 *  3 buckets by T+60, PUMP paths in the top 3. */
export const DEFAULT_BUCKET_BOUNDARIES = [-30, -15, -5, 5, 15, 35] as const;

export const DEFAULT_BUCKET_LABELS = [
  '< -30%',
  '-30..-15%',
  '-15..-5%',
  '-5..+5%',
  '+5..+15%',
  '+15..+35%',
  '> +35%',
] as const;

/** Checkpoints between entry (T+30) and outcome (T+300). All correspond to
 *  pct_tN columns that exist on graduation_momentum. */
export const AGE_CHECKPOINTS_POST_GRAD = [
  35, 40, 45, 50, 55, 60, 90, 120, 150, 180, 240,
] as const;

/** Minimum paths in a (filter, age, bucket) cell before we'll trust its P
 *  estimate. Below this, the markov rule abstains and the fixed SL/TP runs. */
export const MIN_CELL_N = 10;

/** Refit cadence — kicks in once this many new closed paths have landed since
 *  the last refit. */
export const REFIT_PATHS_THRESHOLD = 50;

// ── Types ───────────────────────────────────────────────────────────────────

export interface MatrixCell {
  /** total paths in this (filter, age, bucket) cell */
  n: number;
  /** of those, how many ended with relret_300_from_30 > 0 */
  wins: number;
  /** wins / n */
  p_win: number;
  /** Wilson 95% lower bound on p_win — useful for diagnostics */
  p_win_lower: number;
  /** mean of relret_300_from_30 across the cell */
  mean_final_relret: number;
}

export interface MarkovMatrixForFilter {
  filter_key: string;
  filter_labels: string[];
  entry_gate_min: number;
  entry_gate_max: number;
  /** total paths considered (passed filter + entry gate + had pct_t300) */
  n_total: number;
  /** baseline P(profit at T+300) across all paths matching the filter */
  baseline_p_win: number;
  /** age_sec → bucket_idx → cell */
  cells: Record<number, Record<number, MatrixCell>>;
}

export interface MarkovMatrixDoc {
  generated_at: string;
  paths_consumed: number;
  bucket_boundaries: number[];
  bucket_labels: string[];
  age_checkpoints: number[];
  min_cell_n: number;
  filters: Record<string, MarkovMatrixForFilter>;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Stable key for a filter set. Order-independent: ['vel<20','top5<10%']
 *  produces the same key as ['top5<10%','vel<20']. */
export function filterSetKey(filters: FilterConfig[]): string {
  if (!filters || filters.length === 0) return 'ALL';
  return filters.map(f => f.label).slice().sort().join(' + ');
}

/** Returns bin index in [0..N] where N = boundaries.length. */
export function bucketOfRelret(pct: number, boundaries: readonly number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (pct < boundaries[i]) return i;
  }
  return boundaries.length;
}

/** Largest checkpoint <= ageSec, or null if before the first checkpoint. */
export function nearestCheckpoint(
  ageSec: number,
  checkpoints: readonly number[],
): number | null {
  let best: number | null = null;
  for (const cp of checkpoints) {
    if (cp <= ageSec) best = cp;
    else break;
  }
  return best;
}

/** Wilson 95% lower bound on a binomial proportion. */
function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const num =
    p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, num / denom);
}

/** Translate a FilterConfig into a SQL fragment. Field name is regex-checked. */
function filterToSql(f: FilterConfig): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(f.field)) {
    throw new Error(`Invalid filter field name: ${f.field}`);
  }
  if (!Number.isFinite(f.value)) {
    throw new Error(`Invalid filter value: ${f.value}`);
  }
  const op = f.operator === '==' ? '=' : f.operator;
  return `(${f.field} IS NOT NULL AND ${f.field} ${op} ${f.value})`;
}

/** ((1 + pct_tN/100) / (1 + pct_t30/100) - 1) * 100 */
function relretFrom30(pctTN: number, pctT30: number): number {
  return ((1 + pctTN / 100) / (1 + pctT30 / 100) - 1) * 100;
}

// ── Builder ─────────────────────────────────────────────────────────────────

interface RawPathRow {
  pct_t30: number;
  pct_t35: number | null; pct_t40: number | null; pct_t45: number | null;
  pct_t50: number | null; pct_t55: number | null; pct_t60: number | null;
  pct_t90: number | null; pct_t120: number | null; pct_t150: number | null;
  pct_t180: number | null; pct_t240: number | null; pct_t300: number;
}

const CHECKPOINT_COLS: Record<number, keyof RawPathRow> = {
  35: 'pct_t35', 40: 'pct_t40', 45: 'pct_t45', 50: 'pct_t50',
  55: 'pct_t55', 60: 'pct_t60', 90: 'pct_t90', 120: 'pct_t120',
  150: 'pct_t150', 180: 'pct_t180', 240: 'pct_t240',
};

export function buildMatrixForFilter(
  db: Database.Database,
  filters: FilterConfig[],
  entryGateMin: number,
  entryGateMax: number,
  boundaries: readonly number[] = DEFAULT_BUCKET_BOUNDARIES,
): MarkovMatrixForFilter {
  const key = filterSetKey(filters);
  const labels = filters.map(f => f.label);

  const filterClauses = filters.map(filterToSql);
  const where = [
    'pct_t30 IS NOT NULL',
    `pct_t30 >= ${entryGateMin}`,
    `pct_t30 <= ${entryGateMax}`,
    'pct_t300 IS NOT NULL',
    ...filterClauses,
  ].join(' AND ');

  const cols = [
    'pct_t30',
    ...Object.values(CHECKPOINT_COLS),
    'pct_t300',
  ].join(', ');

  const sql = `SELECT ${cols} FROM graduation_momentum WHERE ${where}`;
  const rows = db.prepare(sql).all() as RawPathRow[];

  // Accumulate per-cell counters.
  const counts: Record<number, Record<number, { n: number; wins: number; sumFinal: number }>> = {};
  let baselineWins = 0;

  for (const r of rows) {
    const finalRelret = relretFrom30(r.pct_t300, r.pct_t30);
    const isWin = finalRelret > 0;
    if (isWin) baselineWins++;

    for (const ageCp of AGE_CHECKPOINTS_POST_GRAD) {
      const col = CHECKPOINT_COLS[ageCp];
      const v = r[col];
      if (v == null) continue;
      const liveRelret = relretFrom30(v as number, r.pct_t30);
      const bucket = bucketOfRelret(liveRelret, boundaries);

      if (!counts[ageCp]) counts[ageCp] = {};
      if (!counts[ageCp][bucket]) counts[ageCp][bucket] = { n: 0, wins: 0, sumFinal: 0 };
      const c = counts[ageCp][bucket];
      c.n++;
      if (isWin) c.wins++;
      c.sumFinal += finalRelret;
    }
  }

  const cells: Record<number, Record<number, MatrixCell>> = {};
  for (const [ageStr, byBucket] of Object.entries(counts)) {
    const age = Number(ageStr);
    cells[age] = {};
    for (const [bStr, c] of Object.entries(byBucket)) {
      const b = Number(bStr);
      const p_win = c.n > 0 ? c.wins / c.n : 0;
      cells[age][b] = {
        n: c.n,
        wins: c.wins,
        p_win: +p_win.toFixed(4),
        p_win_lower: +wilsonLower(c.wins, c.n).toFixed(4),
        mean_final_relret: c.n > 0 ? +(c.sumFinal / c.n).toFixed(2) : 0,
      };
    }
  }

  const baseline_p_win = rows.length > 0 ? +(baselineWins / rows.length).toFixed(4) : 0;

  return {
    filter_key: key,
    filter_labels: labels,
    entry_gate_min: entryGateMin,
    entry_gate_max: entryGateMax,
    n_total: rows.length,
    baseline_p_win,
    cells,
  };
}

// ── In-memory store ────────────────────────────────────────────────────────

interface FilterRegistration {
  filters: FilterConfig[];
  entryGateMin: number;
  entryGateMax: number;
}

export class MarkovMatrixStore {
  private matrices = new Map<string, MarkovMatrixForFilter>();
  private registrations = new Map<string, FilterRegistration>();
  private pathsConsumed = 0;
  private generatedAt: string = new Date(0).toISOString();

  constructor(private readonly boundaries: readonly number[] = DEFAULT_BUCKET_BOUNDARIES) {}

  /** Strategies announce their filter spec at create-time so the next refit
   *  builds a matrix for them. Idempotent. */
  registerFilter(filters: FilterConfig[], entryGateMin: number, entryGateMax: number): string {
    const key = filterSetKey(filters);
    this.registrations.set(key, { filters, entryGateMin, entryGateMax });
    return key;
  }

  /** Returns null if no matrix is built yet, the cell is too sparse, or the
   *  position is too young (before first checkpoint). Caller treats null as
   *  "abstain — let the fixed SL/TP run". */
  lookup(filterKey: string, ageSec: number, curPctFromEntry: number): MatrixCell | null {
    const m = this.matrices.get(filterKey);
    if (!m) return null;
    const cp = nearestCheckpoint(ageSec, AGE_CHECKPOINTS_POST_GRAD);
    if (cp == null) return null;
    const bucket = bucketOfRelret(curPctFromEntry, this.boundaries);
    const cell = m.cells[cp]?.[bucket];
    if (!cell || cell.n < MIN_CELL_N) return null;
    return cell;
  }

  /** Fully rebuild every registered matrix. Cheap — single SQL pass per filter. */
  refitAll(db: Database.Database, totalLabeledPaths: number): void {
    for (const [key, reg] of this.registrations) {
      try {
        const m = buildMatrixForFilter(
          db,
          reg.filters,
          reg.entryGateMin,
          reg.entryGateMax,
          this.boundaries,
        );
        this.matrices.set(key, m);
      } catch {
        // Refusing to crash the bot over a bad filter spec. The matrix will
        // simply stay stale and the fixed SL/TP will continue running.
      }
    }
    this.pathsConsumed = totalLabeledPaths;
    this.generatedAt = new Date().toISOString();
  }

  /** True if at least REFIT_PATHS_THRESHOLD new paths have landed. */
  isRefitDue(currentLabeledPaths: number): boolean {
    return currentLabeledPaths - this.pathsConsumed >= REFIT_PATHS_THRESHOLD;
  }

  pathsAtLastRefit(): number {
    return this.pathsConsumed;
  }

  registeredKeys(): string[] {
    return Array.from(this.registrations.keys());
  }

  toJson(): MarkovMatrixDoc {
    const filters: Record<string, MarkovMatrixForFilter> = {};
    for (const [k, v] of this.matrices) filters[k] = v;
    return {
      generated_at: this.generatedAt,
      paths_consumed: this.pathsConsumed,
      bucket_boundaries: [...this.boundaries],
      bucket_labels: [...DEFAULT_BUCKET_LABELS],
      age_checkpoints: [...AGE_CHECKPOINTS_POST_GRAD],
      min_cell_n: MIN_CELL_N,
      filters,
    };
  }
}
