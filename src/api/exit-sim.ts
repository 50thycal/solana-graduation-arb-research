/**
 * src/api/exit-sim.ts
 *
 * Dynamic-exit strategy simulator. Given a labeled graduation row's
 * pct_t* checkpoint series, replay alternative exit logic (vs the
 * static 10%SL/50%TP baseline) and report avg return / win rate per
 * parameter grid cell.
 *
 * Scope of this commit (#1): momentum-reversal strategy only.
 * Scale-out, vol-adaptive trail, time-decayed TP land in follow-ups.
 *
 * Cost model + price-ratio gap formulas match aggregates.ts:438-470 and
 * src/index.ts:2697-2732 exactly so results are apples-to-apples
 * comparable with the +6.44% baseline on /api/best-combos.
 */

import type Database from 'better-sqlite3';
import {
  SIM_SL_GAP_PENALTY,
  SIM_TP_GAP_PENALTY,
  SIM_DEFAULT_COST_PCT,
} from './sim-constants';

// ── Eligibility / shared SQL ──────────────────────────────────────────

const ENTRY_GATE_SQL =
  'pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100 AND pct_t300 IS NOT NULL';

// Checkpoints walked AFTER entry at T+30 — every 5s from T+35 through T+295.
// Rows from before the every-5s collection rollout have NULLs for t65-t295;
// the walk tolerates this via `if (v == null) continue`.
// Final fall-through is at pct_t300.
const CHECKPOINTS: readonly `pct_t${number}`[] = (() => {
  const cps: `pct_t${number}`[] = [];
  for (let sec = 35; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
  return cps;
})();
type Checkpoint = typeof CHECKPOINTS[number];

// ── Row type ──────────────────────────────────────────────────────────

export type ExitSimRow = {
  created_at: number;
  label: string;
  pct_t30: number;
  pct_t300: number;
  cost_pct: number;
  path_smoothness_0_30: number | null;
  // filter columns for universe selection
  bc_velocity_sol_per_min: number | null;
  top5_wallet_pct: number | null;
} & { [K in Checkpoint]: number | null };

// ── Strategy params ────────────────────────────────────────────────────

export interface MomentumReversalParams {
  /** Drop from HWM in a single checkpoint (% of HWM price) that triggers exit. */
  dropFromHwmPct: number;
  /** HWM must be at least this far above entry before reversal can trigger. */
  minHwmPct: number;
}

export interface DynamicExitParams {
  /** Hard floor SL — % drop from entry. Always active. */
  stopLossPct: number;
  momentumReversal?: MomentumReversalParams;
}

export type ExitReason =
  | 'stop_loss'
  | 'momentum_reversal'
  | 'scale_out_partial_plus_sl'
  | 'scale_out_partial_plus_trail'
  | 'scale_out_partial_plus_timeout'
  | 'vol_trail'
  | 'time_decayed_tp'
  | 'timeout';

export interface SimResult {
  exit_reason: ExitReason;
  exit_checkpoint_sec: number;  // seconds after T+30 entry; 270 = t300 timeout
  net_return_pct: number;       // cost-adjusted
}

// pct_tN → seconds since T+30 entry (N - 30). pct_t300 → 270.
const CHECKPOINT_SECONDS: Record<Checkpoint | 'pct_t300', number> = (() => {
  const m = {} as Record<Checkpoint | 'pct_t300', number>;
  for (const cp of CHECKPOINTS) {
    const sec = Number(cp.slice('pct_t'.length));
    m[cp] = sec - 30;
  }
  m['pct_t300'] = 270;
  return m;
})();

// ── Core sim ───────────────────────────────────────────────────────────

/**
 * Replay one row under the given dynamic-exit params.
 * Cost is applied once at the end (mirrors aggregates.ts:467).
 *
 * Priority order at each checkpoint:
 *   1. SL (price <= entry * (1 - stopLossPct/100))
 *   2. Momentum reversal (if configured)
 *   3. Continue to next checkpoint
 * Final fall-through at pct_t300 with no penalty (timeout exit).
 */
export function simulateDynamicExit(r: ExitSimRow, p: DynamicExitParams): SimResult {
  const entryRatio = 1 + r.pct_t30 / 100;
  const slLevelPct = (entryRatio * (1 - p.stopLossPct / 100) - 1) * 100;

  let hwmPct = r.pct_t30;  // HWM tracked as raw checkpoint % (vs open)

  for (const cp of CHECKPOINTS) {
    const v = r[cp];
    if (v == null) continue;

    // 1. SL — price-ratio gap (matches aggregates.ts:457)
    if (v <= slLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'stop_loss', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    // 2. Momentum reversal — checked before HWM update so the trigger
    //    fires on the FIRST checkpoint where price drops below the
    //    threshold relative to the prior high.
    if (p.momentumReversal) {
      const hwmAboveEntryPct = ((1 + hwmPct / 100) / entryRatio - 1) * 100;
      const hwmRatio = 1 + hwmPct / 100;
      const currRatio = 1 + v / 100;
      const dropFromHwmPct = ((hwmRatio - currRatio) / hwmRatio) * 100;
      if (
        hwmAboveEntryPct >= p.momentumReversal.minHwmPct &&
        dropFromHwmPct >= p.momentumReversal.dropFromHwmPct
      ) {
        const inProfit = v > r.pct_t30;
        const gap = inProfit ? SIM_TP_GAP_PENALTY : SIM_SL_GAP_PENALTY;
        const exitRatio = currRatio * (1 - gap);
        const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
        return { exit_reason: 'momentum_reversal', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
      }
    }

    if (v > hwmPct) hwmPct = v;
  }

  // 3. Timeout fall-through at t300 (no gap penalty — model time-out as fair fill)
  const fallRet = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100 - r.cost_pct;
  return { exit_reason: 'timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: fallRet };
}

// ── DB loader ─────────────────────────────────────────────────────────

export function loadExitSimRows(db: Database.Database): ExitSimRow[] {
  // pct_t30 / pct_t300 are entry + timeout; CHECKPOINTS are the walk (t35…t295).
  const walkCols = CHECKPOINTS.join(', ');
  return db.prepare(`
    SELECT
      created_at, label,
      pct_t30, ${walkCols}, pct_t300,
      COALESCE(round_trip_slippage_pct, ${SIM_DEFAULT_COST_PCT}) as cost_pct,
      path_smoothness_0_30,
      bc_velocity_sol_per_min, top5_wallet_pct
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND ${ENTRY_GATE_SQL}
      AND created_at IS NOT NULL
    ORDER BY created_at ASC
  `).all() as ExitSimRow[];
}

// ── Universe predicates (default = current baseline) ───────────────────

export type UniversePredicate = (r: ExitSimRow) => boolean;

export const BASELINE_UNIVERSE: UniversePredicate = (r) =>
  r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20 &&
  r.top5_wallet_pct != null && r.top5_wallet_pct < 10;

// ── Grid evaluation ────────────────────────────────────────────────────

export interface GridCell {
  params: Record<string, number | string>;
  n: number;
  avg_return_pct: number | null;
  win_rate_pct: number | null;
  exit_reason_breakdown: Record<ExitReason, number>;
}

const MIN_N_FOR_BEST = 30;

const emptyBreakdown = (): Record<ExitReason, number> => ({
  stop_loss: 0, momentum_reversal: 0,
  scale_out_partial_plus_sl: 0, scale_out_partial_plus_trail: 0, scale_out_partial_plus_timeout: 0,
  vol_trail: 0, time_decayed_tp: 0, timeout: 0,
});

export function evaluateMomentumReversalGrid(
  rows: ExitSimRow[],
  universe: UniversePredicate,
  fixedSlPct = 10,
): { grid: GridCell[]; best: GridCell | null } {
  const dropGrid = [3, 5, 7, 10] as const;
  const minHwmGrid = [10, 20, 30] as const;
  const filtered = rows.filter(universe);
  const cells: GridCell[] = [];

  for (const drop of dropGrid) {
    for (const minHwm of minHwmGrid) {
      const params: DynamicExitParams = {
        stopLossPct: fixedSlPct,
        momentumReversal: { dropFromHwmPct: drop, minHwmPct: minHwm },
      };
      const breakdown: Record<ExitReason, number> = emptyBreakdown();
      let sum = 0;
      let wins = 0;
      const n = filtered.length;
      for (const r of filtered) {
        const out = simulateDynamicExit(r, params);
        sum += out.net_return_pct;
        if (out.net_return_pct > 0) wins++;
        breakdown[out.exit_reason]++;
      }
      cells.push({
        params: { drop_from_hwm_pct: drop, min_hwm_pct: minHwm, sl_pct: fixedSlPct },
        n,
        avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
        win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
        exit_reason_breakdown: breakdown,
      });
    }
  }

  let best: GridCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || (c.avg_return_pct > (best.avg_return_pct ?? -Infinity))) best = c;
  }

  return { grid: cells, best };
}

// ── Strategy 2: Scale-out / partial exits ───────────────────────────────
// Sell firstTpSizePct at first checkpoint where v >= firstTpPct. Remainder
// (runner) then trails at runnerTrailPct below its own post-partial HWM,
// exits on SL from entry, or falls through at t300. Cost applied once.

export interface ScaleOutParams {
  firstTpPct: number;
  firstTpSizePct: number; // 0..1
  runnerTrailPct: number;
}

function simulateScaleOut(r: ExitSimRow, p: { stopLossPct: number; scaleOut: ScaleOutParams }): SimResult {
  const entryRatio = 1 + r.pct_t30 / 100;
  const slLevelPct = (entryRatio * (1 - p.stopLossPct / 100) - 1) * 100;
  const so = p.scaleOut;

  let partialLegRet: number | null = null;
  let runnerHwm = r.pct_t30;
  let triggered = false;

  for (const cp of CHECKPOINTS) {
    const v = r[cp];
    if (v == null) continue;

    // Pre-partial: SL check against entry
    if (!triggered && v <= slLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'stop_loss', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    // Trigger partial TP
    if (!triggered && v >= so.firstTpPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_TP_GAP_PENALTY);
      partialLegRet = (exitRatio / entryRatio - 1) * 100;
      runnerHwm = v;
      triggered = true;
      continue;
    }

    // Post-partial: runner tracking
    if (triggered) {
      // SL still active on runner (from entry)
      if (v <= slLevelPct) {
        const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
        const runnerRet = (exitRatio / entryRatio - 1) * 100;
        const net = so.firstTpSizePct * (partialLegRet as number)
                  + (1 - so.firstTpSizePct) * runnerRet
                  - r.cost_pct;
        return { exit_reason: 'scale_out_partial_plus_sl', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: net };
      }
      if (v > runnerHwm) runnerHwm = v;
      const hwmRatio = 1 + runnerHwm / 100;
      const currRatio = 1 + v / 100;
      const dropFromHwm = ((hwmRatio - currRatio) / hwmRatio) * 100;
      if (dropFromHwm >= so.runnerTrailPct) {
        const inProfit = v > r.pct_t30;
        const gap = inProfit ? SIM_TP_GAP_PENALTY : SIM_SL_GAP_PENALTY;
        const exitRatio = currRatio * (1 - gap);
        const runnerRet = (exitRatio / entryRatio - 1) * 100;
        const net = so.firstTpSizePct * (partialLegRet as number)
                  + (1 - so.firstTpSizePct) * runnerRet
                  - r.cost_pct;
        return { exit_reason: 'scale_out_partial_plus_trail', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: net };
      }
    }
  }

  // Final fall-through
  const t300Ret = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100;
  if (triggered) {
    const net = so.firstTpSizePct * (partialLegRet as number)
              + (1 - so.firstTpSizePct) * t300Ret
              - r.cost_pct;
    return { exit_reason: 'scale_out_partial_plus_timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: net };
  }
  return { exit_reason: 'timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: t300Ret - r.cost_pct };
}

export function evaluateScaleOutGrid(
  rows: ExitSimRow[],
  universe: UniversePredicate,
  fixedSlPct = 10,
): { grid: GridCell[]; best: GridCell | null } {
  const firstTpGrid = [15, 25, 35] as const;
  const sizeGrid = [0.50, 0.67] as const;
  const trailGrid = [5, 10] as const;
  const filtered = rows.filter(universe);
  const cells: GridCell[] = [];

  for (const tp of firstTpGrid) for (const size of sizeGrid) for (const trail of trailGrid) {
    const bd = emptyBreakdown();
    let sum = 0, wins = 0;
    for (const r of filtered) {
      const out = simulateScaleOut(r, { stopLossPct: fixedSlPct, scaleOut: { firstTpPct: tp, firstTpSizePct: size, runnerTrailPct: trail } });
      sum += out.net_return_pct;
      if (out.net_return_pct > 0) wins++;
      bd[out.exit_reason]++;
    }
    const n = filtered.length;
    cells.push({
      params: { first_tp_pct: tp, size_pct: size, runner_trail_pct: trail, sl_pct: fixedSlPct },
      n,
      avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
      win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
      exit_reason_breakdown: bd,
    });
  }

  let best: GridCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || c.avg_return_pct > (best.avg_return_pct ?? -Infinity)) best = c;
  }
  return { grid: cells, best };
}

// ── Strategy 3: Volatility-adaptive trailing ────────────────────────────
// Trail distance = k * path_smoothness_0_30. Activates once price >= entry.
// Rows with null path_smoothness_0_30 are skipped (counted but excluded).

export interface VolAdaptiveParams { k: number; }

function simulateVolAdaptive(r: ExitSimRow, p: { stopLossPct: number; vol: VolAdaptiveParams }): SimResult | null {
  if (r.path_smoothness_0_30 == null) return null;
  const entryRatio = 1 + r.pct_t30 / 100;
  const slLevelPct = (entryRatio * (1 - p.stopLossPct / 100) - 1) * 100;
  const trailDistPct = p.vol.k * r.path_smoothness_0_30;

  let hwmPct = r.pct_t30;
  let active = false;

  for (const cp of CHECKPOINTS) {
    const v = r[cp];
    if (v == null) continue;

    if (v <= slLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'stop_loss', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    if (!active && v >= r.pct_t30) active = true;

    if (active) {
      const hwmRatio = 1 + hwmPct / 100;
      const currRatio = 1 + v / 100;
      const dropFromHwm = ((hwmRatio - currRatio) / hwmRatio) * 100;
      if (dropFromHwm >= trailDistPct) {
        const inProfit = v > r.pct_t30;
        const gap = inProfit ? SIM_TP_GAP_PENALTY : SIM_SL_GAP_PENALTY;
        const exitRatio = currRatio * (1 - gap);
        const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
        return { exit_reason: 'vol_trail', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
      }
    }
    if (v > hwmPct) hwmPct = v;
  }

  const fallRet = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100 - r.cost_pct;
  return { exit_reason: 'timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: fallRet };
}

export function evaluateVolAdaptiveGrid(
  rows: ExitSimRow[],
  universe: UniversePredicate,
  fixedSlPct = 10,
): { grid: GridCell[]; best: GridCell | null; rows_with_vol: number } {
  const kGrid = [1, 1.5, 2, 2.5, 3] as const;
  const filtered = rows.filter(universe);
  const rowsWithVol = filtered.filter(r => r.path_smoothness_0_30 != null);
  const cells: GridCell[] = [];

  for (const k of kGrid) {
    const bd = emptyBreakdown();
    let sum = 0, wins = 0, n = 0;
    for (const r of filtered) {
      const out = simulateVolAdaptive(r, { stopLossPct: fixedSlPct, vol: { k } });
      if (out == null) continue; // skipped (null vol)
      sum += out.net_return_pct;
      if (out.net_return_pct > 0) wins++;
      bd[out.exit_reason]++;
      n++;
    }
    cells.push({
      params: { k, sl_pct: fixedSlPct },
      n,
      avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
      win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
      exit_reason_breakdown: bd,
    });
  }

  let best: GridCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || c.avg_return_pct > (best.avg_return_pct ?? -Infinity)) best = c;
  }
  return { grid: cells, best, rows_with_vol: rowsWithVol.length };
}

// ── Strategy 5: Time-decayed TP ladder ──────────────────────────────────
// Exit when v >= current ladder target. Target is piecewise-constant,
// looked up by the floor entry whose `seconds` <= elapsed.

export interface TpLadderStep { seconds: number; tpPct: number; }
export interface TimeDecayedTpPreset { name: string; ladder: TpLadderStep[]; }

export const TP_LADDER_PRESETS: TimeDecayedTpPreset[] = [
  { name: 'aggressive',  ladder: [{ seconds: 0, tpPct: 50 }, { seconds: 60, tpPct: 30 }, { seconds: 150, tpPct: 15 }, { seconds: 210, tpPct: 5 }] },
  { name: 'linear',      ladder: [{ seconds: 0, tpPct: 50 }, { seconds: 30, tpPct: 40 }, { seconds: 90, tpPct: 30 }, { seconds: 150, tpPct: 20 }, { seconds: 210, tpPct: 10 }] },
  { name: 'exponential', ladder: [{ seconds: 0, tpPct: 50 }, { seconds: 30, tpPct: 30 }, { seconds: 90, tpPct: 15 }, { seconds: 150, tpPct: 8 },  { seconds: 210, tpPct: 0 }] },
  { name: 'conservative',ladder: [{ seconds: 0, tpPct: 75 }, { seconds: 90, tpPct: 50 }, { seconds: 210, tpPct: 25 }] },
];

function currentTpTarget(ladder: TpLadderStep[], elapsedSec: number): number {
  let target = ladder[0].tpPct;
  for (const step of ladder) if (elapsedSec >= step.seconds) target = step.tpPct;
  return target;
}

function simulateTimeDecayedTp(r: ExitSimRow, p: { stopLossPct: number; ladder: TpLadderStep[] }): SimResult {
  const entryRatio = 1 + r.pct_t30 / 100;
  const slLevelPct = (entryRatio * (1 - p.stopLossPct / 100) - 1) * 100;

  for (const cp of CHECKPOINTS) {
    const v = r[cp];
    if (v == null) continue;
    const elapsed = CHECKPOINT_SECONDS[cp];

    if (v <= slLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'stop_loss', exit_checkpoint_sec: elapsed, net_return_pct: ret };
    }

    const tpTarget = currentTpTarget(p.ladder, elapsed);
    // relRet vs entry
    const relRet = ((1 + v / 100) / entryRatio - 1) * 100;
    if (relRet >= tpTarget) {
      const exitRatio = (1 + v / 100) * (1 - SIM_TP_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'time_decayed_tp', exit_checkpoint_sec: elapsed, net_return_pct: ret };
    }
  }

  const fallRet = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100 - r.cost_pct;
  return { exit_reason: 'timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: fallRet };
}

export function evaluateTimeDecayedTpGrid(
  rows: ExitSimRow[],
  universe: UniversePredicate,
  fixedSlPct = 10,
): { grid: GridCell[]; best: GridCell | null } {
  const filtered = rows.filter(universe);
  const cells: GridCell[] = [];

  for (const preset of TP_LADDER_PRESETS) {
    const bd = emptyBreakdown();
    let sum = 0, wins = 0;
    for (const r of filtered) {
      const out = simulateTimeDecayedTp(r, { stopLossPct: fixedSlPct, ladder: preset.ladder });
      sum += out.net_return_pct;
      if (out.net_return_pct > 0) wins++;
      bd[out.exit_reason]++;
    }
    const n = filtered.length;
    cells.push({
      params: { preset: preset.name, ladder: JSON.stringify(preset.ladder), sl_pct: fixedSlPct },
      n,
      avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
      win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
      exit_reason_breakdown: bd,
    });
  }

  let best: GridCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || c.avg_return_pct > (best.avg_return_pct ?? -Infinity)) best = c;
  }
  return { grid: cells, best };
}

// ── Top-level entrypoint ───────────────────────────────────────────────

export interface ExitSimReport {
  generated_at: string;
  universe: { label: string; n_rows: number };
  baseline_static: GridCell;  // 10% SL / 50% TP, for comparison
  strategies: {
    momentum_reversal: { grid: GridCell[]; best: GridCell | null };
    scale_out:         { grid: GridCell[]; best: GridCell | null };
    vol_adaptive:      { grid: GridCell[]; best: GridCell | null; rows_with_vol: number };
    time_decayed_tp:   { grid: GridCell[]; best: GridCell | null };
    whale_liq:         { status: 'DATA_PENDING'; required_data: string[] };
  };
}

/** Static 10%SL/50%TP baseline cell — recomputed inline to keep this file self-contained. */
function computeStaticBaseline(rows: ExitSimRow[], universe: UniversePredicate): GridCell {
  const filtered = rows.filter(universe);
  const breakdown = emptyBreakdown();
  let sum = 0;
  let wins = 0;
  const SL = 10, TP = 50;

  for (const r of filtered) {
    const entryRatio = 1 + r.pct_t30 / 100;
    const slLvl = (entryRatio * (1 - SL / 100) - 1) * 100;
    const tpLvl = (entryRatio * (1 + TP / 100) - 1) * 100;
    let exitPct: number | null = null;
    let isSl = false;
    for (const cp of CHECKPOINTS) {
      const v = r[cp];
      if (v == null) continue;
      if (v <= slLvl) {
        const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
        exitPct = (exitRatio / entryRatio - 1) * 100;
        isSl = true;
        break;
      }
      if (v >= tpLvl) { exitPct = TP * (1 - SIM_TP_GAP_PENALTY); break; }
    }
    if (exitPct === null) {
      exitPct = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100;
      breakdown.timeout++;
    } else if (isSl) {
      breakdown.stop_loss++;
    } else {
      breakdown.time_decayed_tp++;  // static 50% TP exit — bucket under the TP family
    }
    const net = exitPct - r.cost_pct;
    sum += net;
    if (net > 0) wins++;
  }
  const n = filtered.length;
  return {
    params: { sl_pct: SL, tp_pct: TP, type: 'static_baseline' },
    n,
    avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
    win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
    exit_reason_breakdown: breakdown,
  };
}

export function computeExitSim(
  db: Database.Database,
  opts: { universe?: UniversePredicate; universeLabel?: string } = {},
): ExitSimReport {
  const universe = opts.universe ?? BASELINE_UNIVERSE;
  const universeLabel = opts.universeLabel ?? 'vel<20 + top5<10% (current baseline)';
  const rows = loadExitSimRows(db);
  const filtered = rows.filter(universe);

  return {
    generated_at: new Date().toISOString(),
    universe: { label: universeLabel, n_rows: filtered.length },
    baseline_static: computeStaticBaseline(rows, universe),
    strategies: {
      momentum_reversal: evaluateMomentumReversalGrid(rows, universe),
      scale_out:         evaluateScaleOutGrid(rows, universe),
      vol_adaptive:      evaluateVolAdaptiveGrid(rows, universe),
      time_decayed_tp:   evaluateTimeDecayedTpGrid(rows, universe),
      whale_liq: {
        status: 'DATA_PENDING',
        required_data: [
          'liquidity_sol_t60/t120/t300 columns on graduation_momentum',
          'post_grad_swaps table for per-swap T+30..T+300 logs',
          'PumpSwap pool log subscription extended to 0-300s window',
        ],
      },
    },
  };
}
