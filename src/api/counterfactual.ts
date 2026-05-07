import type Database from 'better-sqlite3';
import {
  simulateComboFullGrid,
  type SimulateComboCell,
  yieldEventLoop,
} from './aggregates';
import { SIM_TP_GRID, SIM_SL_GRID, SIM_MIN_TP_HITS_FOR_OPTIMUM } from './sim-constants';
import type { FilterConfig, StrategyParams } from '../trading/config';

/**
 * Per-strategy filter + TP/SL counterfactual.
 *
 * Two questions per strategy:
 *   1. Is each filter pulling weight, or is it dead weight that just shrinks
 *      sample size for no return gain? Drop each filter individually and
 *      re-run the simulator; report Δn and Δopt_avg_ret.
 *   2. Is the configured (tp, sl) the best cell on the grid? Snap the
 *      configured TP/SL to the nearest grid point, look up the cell, then
 *      report the top 3 alternatives by avg_ret with deltas vs configured.
 *
 * Uses simulateComboFullGrid so the cost model + grid are identical to
 * /api/best-combos. Trusted SQL — field names are allow-listed against the
 * live graduation_momentum schema and operators against a fixed set.
 */

const ALLOWED_OPERATORS = new Set(['>=', '<=', '>', '<', '=', '!=', '<>', '==']);

/** Map TS operator → safe SQL operator. `==` is JS-style; `!=`/`<>` both valid in SQLite. */
function sqlOperator(op: string): string {
  if (op === '==') return '=';
  return op;
}

/** Safe field-name pattern: must look like a SQL identifier. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface FilterDropResult {
  label: string;
  field: string;
  operator: string;
  value: number;
  /** Sample size with the full filter stack. */
  n_with: number;
  /** Sample size after dropping this filter. */
  n_without: number;
  /** opt_avg_ret with full stack (always the same per strategy — surfaced for context). */
  opt_avg_ret_with: number | null;
  /** opt_avg_ret after dropping this filter. */
  opt_avg_ret_without: number | null;
  /** Δret_pp = without - with. Negative means dropping hurts (filter pulls weight); positive means filter is dead weight. */
  delta_ret_pp: number | null;
  delta_n: number;
  /** Plain-English verdict for the panel. */
  verdict: 'pulls weight' | 'dead weight' | 'hurts' | 'unknown';
}

interface TpSlAlternative {
  tp: number;
  sl: number;
  avg_ret: number;
  win_rate: number;
  /** Δret_pp vs the strategy's configured cell. */
  delta_ret_pp: number;
  /** Δwin_rate_pp vs the strategy's configured cell. */
  delta_win_rate_pp: number;
}

export interface CounterfactualRow {
  strategy_id: string;
  label: string;
  execution_mode: string;
  entry_sec: number;
  /** Configured (tp, sl) snapped to the nearest grid point. */
  configured: {
    tp_input: number;
    sl_input: number;
    tp_grid: number;
    sl_grid: number;
    avg_ret: number | null;
    win_rate: number | null;
  };
  /** opt cell from the baseline grid (max avg_ret with n_hit_tp >= SIM_MIN_TP_HITS_FOR_OPTIMUM). */
  opt: {
    tp: number | null;
    sl: number | null;
    avg_ret: number | null;
    win_rate: number | null;
  };
  /** Top 3 alternative cells by avg_ret (excludes configured, gated by tp-hit min). */
  tp_sl_alternatives: TpSlAlternative[];
  baseline_n: number;
  filter_drops: FilterDropResult[];
  /** Set when the strategy's filters[] couldn't be safely converted to SQL. */
  error: string | null;
}

export interface CounterfactualData {
  generated_at: string;
  strategy_count: number;
  rows: CounterfactualRow[];
  notes: string[];
}

interface StrategyConfigBundle {
  id: string;
  label: string;
  enabled: boolean;
  params: StrategyParams;
}

function fetchEnabledStrategies(db: Database.Database): StrategyConfigBundle[] {
  const rows = db.prepare(`
    SELECT id, label, enabled, config_json FROM strategy_configs WHERE enabled = 1
  `).all() as Array<{ id: string; label: string; enabled: number; config_json: string }>;
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    enabled: r.enabled === 1,
    params: JSON.parse(r.config_json) as StrategyParams,
  }));
}

function fetchAllowedFields(db: Database.Database): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(graduation_momentum)`)
    .all() as Array<{ name: string }>;
  return new Set(cols.map(c => c.name));
}

function buildClause(f: FilterConfig, allowedFields: Set<string>): { clause: string } | { error: string } {
  if (!SAFE_IDENT.test(f.field)) return { error: `Field "${f.field}" failed safety check` };
  if (!allowedFields.has(f.field)) return { error: `Field "${f.field}" not on graduation_momentum` };
  if (!ALLOWED_OPERATORS.has(f.operator)) return { error: `Operator "${f.operator}" not allowed` };
  if (typeof f.value !== 'number' || !Number.isFinite(f.value)) {
    return { error: `Value for ${f.field} is not a finite number` };
  }
  return { clause: `(${f.field} ${sqlOperator(f.operator)} ${f.value})` };
}

function nearestIndex(arr: readonly number[], target: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - target);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

function pickOptCell(grid: SimulateComboCell[]): SimulateComboCell | null {
  let best: SimulateComboCell | null = null;
  for (const cell of grid) {
    if (cell.n_hit_tp < SIM_MIN_TP_HITS_FOR_OPTIMUM) continue;
    if (best === null || cell.avg_ret > best.avg_ret) best = cell;
  }
  return best;
}

function classifyFilter(deltaRetPp: number | null): FilterDropResult['verdict'] {
  if (deltaRetPp == null) return 'unknown';
  // delta = without - with. Negative = dropping hurts (filter is doing work).
  if (deltaRetPp <= -1) return 'pulls weight';
  if (deltaRetPp >= 1) return 'hurts';
  return 'dead weight';
}

export async function computeCounterfactual(db: Database.Database): Promise<CounterfactualData> {
  const generated_at = new Date().toISOString();
  const strategies = fetchEnabledStrategies(db);

  if (strategies.length === 0) {
    return {
      generated_at,
      strategy_count: 0,
      rows: [],
      notes: ['No active strategies — toggle one on to populate this panel.'],
    };
  }

  const allowedFields = fetchAllowedFields(db);
  const rows: CounterfactualRow[] = [];

  for (const strat of strategies) {
    const p = strat.params;
    const entrySec = p.entryTimingSec ?? 30;

    // Build per-filter clauses; track which ones failed validation so the
    // panel can surface the error instead of silently dropping the strategy.
    const filterClauses: Array<{ filter: FilterConfig; clause: string }> = [];
    const validationErrors: string[] = [];
    for (const f of p.filters ?? []) {
      const r = buildClause(f, allowedFields);
      if ('error' in r) validationErrors.push(`${f.label}: ${r.error}`);
      else filterClauses.push({ filter: f, clause: r.clause });
    }

    if (validationErrors.length > 0 && filterClauses.length === 0) {
      rows.push({
        strategy_id: strat.id,
        label: strat.label,
        execution_mode: p.executionMode ?? 'paper',
        entry_sec: entrySec,
        configured: {
          tp_input: p.takeProfitPct,
          sl_input: p.stopLossPct,
          tp_grid: SIM_TP_GRID[nearestIndex(SIM_TP_GRID, p.takeProfitPct)],
          sl_grid: SIM_SL_GRID[nearestIndex(SIM_SL_GRID, p.stopLossPct)],
          avg_ret: null, win_rate: null,
        },
        opt: { tp: null, sl: null, avg_ret: null, win_rate: null },
        tp_sl_alternatives: [],
        baseline_n: 0,
        filter_drops: [],
        error: `All filters failed validation: ${validationErrors.join('; ')}`,
      });
      continue;
    }

    // Baseline = full filter stack. If a strategy has no filters, the
    // baseline becomes "any token through the entry gate". Use "1=1" as the
    // SQL no-op so simulateComboFullGrid still applies the gate.
    const baselineWhere = filterClauses.length > 0
      ? filterClauses.map(c => c.clause).join(' AND ')
      : '1=1';
    const baselineFull = simulateComboFullGrid(db, baselineWhere, entrySec);
    const baselineOpt = pickOptCell(baselineFull.grid);

    // Configured cell (snapped to nearest grid point).
    const tpIdx = nearestIndex(SIM_TP_GRID, p.takeProfitPct);
    const slIdx = nearestIndex(SIM_SL_GRID, p.stopLossPct);
    const configuredCell = baselineFull.grid.length > 0
      ? baselineFull.grid[tpIdx * SIM_SL_GRID.length + slIdx]
      : null;

    // Top 3 alternatives by avg_ret, excluding the configured cell, gated by
    // SIM_MIN_TP_HITS_FOR_OPTIMUM so single-trade outliers don't surface.
    const alternatives: TpSlAlternative[] = baselineFull.grid
      .filter((cell, i) => {
        if (cell.n_hit_tp < SIM_MIN_TP_HITS_FOR_OPTIMUM) return false;
        return i !== tpIdx * SIM_SL_GRID.length + slIdx;
      })
      .sort((a, b) => b.avg_ret - a.avg_ret)
      .slice(0, 3)
      .map(cell => ({
        tp: cell.tp,
        sl: cell.sl,
        avg_ret: cell.avg_ret,
        win_rate: cell.win_rate,
        delta_ret_pp: configuredCell != null
          ? +(cell.avg_ret - configuredCell.avg_ret).toFixed(2)
          : 0,
        delta_win_rate_pp: configuredCell != null
          ? +(cell.win_rate - configuredCell.win_rate).toFixed(1)
          : 0,
      }));

    // Filter-drop sweep — for each filter, rebuild WHERE without it and re-sim.
    // Skip if there's only one filter (drop = no filters at all) to avoid
    // confusing "drop the only filter" output.
    const drops: FilterDropResult[] = [];
    for (let i = 0; i < filterClauses.length; i++) {
      const dropped = filterClauses[i].filter;
      const remaining = filterClauses.filter((_, j) => j !== i);
      const droppedWhere = remaining.length > 0
        ? remaining.map(c => c.clause).join(' AND ')
        : '1=1';
      const droppedFull = simulateComboFullGrid(db, droppedWhere, entrySec);
      const droppedOpt = pickOptCell(droppedFull.grid);

      const delta = baselineOpt != null && droppedOpt != null
        ? +(droppedOpt.avg_ret - baselineOpt.avg_ret).toFixed(2)
        : null;

      drops.push({
        label: dropped.label,
        field: dropped.field,
        operator: dropped.operator,
        value: dropped.value,
        n_with: baselineFull.n,
        n_without: droppedFull.n,
        opt_avg_ret_with: baselineOpt?.avg_ret ?? null,
        opt_avg_ret_without: droppedOpt?.avg_ret ?? null,
        delta_ret_pp: delta,
        delta_n: droppedFull.n - baselineFull.n,
        verdict: classifyFilter(delta),
      });

      // Yield to the event loop between filters — each simulateComboFullGrid
      // is up to ~200ms of synchronous SQLite + grid walk. Without this a
      // strategy with 5 filters could freeze the loop for 1s+ during the
      // counterfactual compute.
      await yieldEventLoop();
    }

    rows.push({
      strategy_id: strat.id,
      label: strat.label,
      execution_mode: p.executionMode ?? 'paper',
      entry_sec: entrySec,
      configured: {
        tp_input: p.takeProfitPct,
        sl_input: p.stopLossPct,
        tp_grid: SIM_TP_GRID[tpIdx],
        sl_grid: SIM_SL_GRID[slIdx],
        avg_ret: configuredCell?.avg_ret ?? null,
        win_rate: configuredCell?.win_rate ?? null,
      },
      opt: {
        tp: baselineOpt?.tp ?? null,
        sl: baselineOpt?.sl ?? null,
        avg_ret: baselineOpt?.avg_ret ?? null,
        win_rate: baselineOpt?.win_rate ?? null,
      },
      tp_sl_alternatives: alternatives,
      baseline_n: baselineFull.n,
      filter_drops: drops,
      error: validationErrors.length > 0
        ? `Some filters failed validation and were skipped: ${validationErrors.join('; ')}`
        : null,
    });
  }

  return {
    generated_at,
    strategy_count: strategies.length,
    rows,
    notes: [
      'Filter contribution: drops each filter individually, re-runs the simulator at the strategy\'s entryTimingSec. delta_ret_pp negative = dropping hurts (filter pulls weight), positive = drop helps (filter is hurting), |delta| < 1pp = dead weight.',
      'TP/SL alternatives: top 3 cells from the baseline 12×10 grid by avg_ret, excluding the configured cell, gated by SIM_MIN_TP_HITS_FOR_OPTIMUM = 3 to avoid single-trade outliers.',
      'Configured (tp, sl) is snapped to the nearest grid point; the cell\'s avg_ret may differ slightly from a hypothetical exact-tp/sl simulation.',
      'Same SIM_TP_GRID × SIM_SL_GRID + cost/gap model as /api/best-combos. opt cell uses the same gate (n >= SIM_MIN_N_FOR_OPTIMUM, n_hit_tp >= SIM_MIN_TP_HITS_FOR_OPTIMUM).',
    ],
  };
}
