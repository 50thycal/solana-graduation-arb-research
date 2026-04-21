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
  | 'liquidity_drop'
  | 'whale_sell'
  | 'take_profit'
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

export function loadExitSimRows(db: Database.Database, extraWhere?: string): ExitSimRow[] {
  // pct_t30 / pct_t300 are entry + timeout; CHECKPOINTS are the walk (t35…t295).
  const walkCols = CHECKPOINTS.join(', ');
  const extra = extraWhere && extraWhere.trim().length > 0 ? ` AND (${extraWhere})` : '';
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
      AND created_at IS NOT NULL${extra}
    ORDER BY created_at ASC
  `).all() as ExitSimRow[];
}

// ── Universe predicates (default = reference universe) ────────────────
//
// `BASELINE_UNIVERSE` is the pinned reference universe for the single-
// universe /exit-sim page. It's no longer "the baseline" in the research
// sense — best-combos.json ranks every candidate at its own opt TP/SL and
// the rolling baseline is the entry-gated ALL-population opt_avg_ret —
// but this universe is kept as a fixed comparison anchor so /exit-sim
// stays stable when the live leader rotates. For multi-combo comparisons
// use /exit-sim-matrix.

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
  vol_trail: 0, time_decayed_tp: 0,
  liquidity_drop: 0, whale_sell: 0, take_profit: 0,
  timeout: 0,
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

// ── Strategy 4: Whale-sell / liquidity-drop ─────────────────────────────
// Dynamic exit triggered on adverse pool-side signals during the hold:
//   (a) liquidity drop — pool SOL reserves fall by >= liqDropPct from entry
//   (b) whale sell    — a single sell swap of >= whaleSellSol SOL since prev cp
// SL (10%) + TP (50%) still active — whale-liq signals are ADDED to the
// baseline exits, so the comparison answers "does the adverse signal
// provide net positive edge on top of 10%SL/50%TP?".

export interface WhaleLiqParams {
  liqDropPct: number;    // % drop from liquidity_sol_t30 that triggers exit
  whaleSellSol: number;  // single sell swap amount (SOL) that triggers exit
}

export interface WhaleLiqSwap {
  sec: number;            // seconds_since_graduation
  action: string;         // 'buy' | 'sell' | 'unknown'
  amount_sol: number | null;
}

// Keyed by checkpoint sec (30, 35, 40, ..., 300). null = NULL in DB (pre-rollout
// row or missed snapshot). Consumers must tolerate nulls.
export type LiquiditySeries = Record<number, number | null>;

export type WhaleLiqRow = ExitSimRow & {
  liq_t30: number | null;
  liq_series: LiquiditySeries;
  swaps: WhaleLiqSwap[];  // sorted by sec asc
};

function simulateWhaleLiq(
  r: WhaleLiqRow,
  p: { stopLossPct: number; takeProfitPct: number; whaleLiq: WhaleLiqParams },
): SimResult | null {
  // Entry-liquidity is required — without it we can't evaluate the drop trigger.
  if (r.liq_t30 == null) return null;

  const entryRatio = 1 + r.pct_t30 / 100;
  const slLevelPct = (entryRatio * (1 - p.stopLossPct / 100) - 1) * 100;
  const tpLevelPct = (entryRatio * (1 + p.takeProfitPct / 100) - 1) * 100;
  const liqFloor = r.liq_t30 * (1 - p.whaleLiq.liqDropPct / 100);

  // Swap iterator — we walk swaps in parallel with checkpoints. At each cp
  // we consume all swaps with sec in (prevSec, cpSec] and check for whales.
  let swapIdx = 0;
  let prevCpSec = 30;  // entry time

  for (const cp of CHECKPOINTS) {
    const v = r[cp];
    if (v == null) continue;
    const cpSec = CHECKPOINT_SECONDS[cp] + 30; // CHECKPOINT_SECONDS is rel-to-entry

    // 1. SL
    if (v <= slLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'stop_loss', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    // 2. TP (before adverse triggers — take the good news first)
    if (v >= tpLevelPct) {
      const exitRatio = (1 + v / 100) * (1 - SIM_TP_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'take_profit', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    // 3. Whale sell — any sell in (prevCpSec, cpSec] meeting threshold.
    //    Advance swapIdx through any swaps at or before this cp window.
    while (swapIdx < r.swaps.length && r.swaps[swapIdx].sec <= cpSec) {
      const s = r.swaps[swapIdx];
      if (
        s.sec > prevCpSec &&
        s.action === 'sell' &&
        s.amount_sol != null &&
        s.amount_sol >= p.whaleLiq.whaleSellSol
      ) {
        // Exit at this checkpoint's price — treat as adverse (SL-style gap).
        const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
        const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
        return { exit_reason: 'whale_sell', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
      }
      swapIdx++;
    }

    // 4. Liquidity drop — pool SOL at this cp vs entry.
    const liqAtCp = r.liq_series[cpSec];
    if (liqAtCp != null && liqAtCp <= liqFloor) {
      const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
      const ret = (exitRatio / entryRatio - 1) * 100 - r.cost_pct;
      return { exit_reason: 'liquidity_drop', exit_checkpoint_sec: CHECKPOINT_SECONDS[cp], net_return_pct: ret };
    }

    prevCpSec = cpSec;
  }

  // 5. Timeout at t300 (no gap penalty — fair fill)
  const fallRet = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100 - r.cost_pct;
  return { exit_reason: 'timeout', exit_checkpoint_sec: CHECKPOINT_SECONDS.pct_t300, net_return_pct: fallRet };
}

/**
 * Load rows with the extra liquidity series + post-grad swap arrays needed
 * for the whale-liq simulator. Only returns rows with `liquidity_sol_t30`
 * present (pre-rollout rows are silently filtered out).
 */
export function loadWhaleLiqRows(db: Database.Database, extraWhere?: string): WhaleLiqRow[] {
  const walkCols = CHECKPOINTS.join(', ');
  // liquidity_sol_t{30..300} every 5s — mirrors the CHECKPOINTS grid plus entry (t30).
  const liqCols: string[] = ['liquidity_sol_t30'];
  for (let sec = 35; sec <= 295; sec += 5) liqCols.push(`liquidity_sol_t${sec}`);
  liqCols.push('liquidity_sol_t300');

  const extra = extraWhere && extraWhere.trim().length > 0 ? ` AND (${extraWhere})` : '';
  const baseRows = db.prepare(`
    SELECT
      graduation_id,
      created_at, label,
      pct_t30, ${walkCols}, pct_t300,
      COALESCE(round_trip_slippage_pct, ${SIM_DEFAULT_COST_PCT}) as cost_pct,
      path_smoothness_0_30,
      bc_velocity_sol_per_min, top5_wallet_pct,
      ${liqCols.join(', ')}
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND ${ENTRY_GATE_SQL}
      AND created_at IS NOT NULL
      AND liquidity_sol_t30 IS NOT NULL${extra}
    ORDER BY created_at ASC
  `).all() as Array<Record<string, number | string | null>>;

  if (baseRows.length === 0) return [];

  // Bulk-fetch swaps grouped by graduation_id to avoid N+1.
  const gradIds = baseRows.map((r) => r.graduation_id as number);
  const placeholders = gradIds.map(() => '?').join(',');
  const swapRows = db.prepare(`
    SELECT graduation_id, seconds_since_graduation as sec, action, amount_sol
    FROM post_grad_swaps
    WHERE graduation_id IN (${placeholders})
    ORDER BY graduation_id, seconds_since_graduation ASC
  `).all(...gradIds) as Array<{ graduation_id: number; sec: number; action: string; amount_sol: number | null }>;

  const swapsByGrad = new Map<number, WhaleLiqSwap[]>();
  for (const s of swapRows) {
    let arr = swapsByGrad.get(s.graduation_id);
    if (!arr) { arr = []; swapsByGrad.set(s.graduation_id, arr); }
    arr.push({ sec: s.sec, action: s.action, amount_sol: s.amount_sol });
  }

  return baseRows.map((b) => {
    const liq_series: LiquiditySeries = {};
    liq_series[30] = b.liquidity_sol_t30 as number | null;
    for (let sec = 35; sec <= 295; sec += 5) {
      liq_series[sec] = (b[`liquidity_sol_t${sec}`] as number | null) ?? null;
    }
    liq_series[300] = (b.liquidity_sol_t300 as number | null) ?? null;

    return {
      created_at: b.created_at as number,
      label: b.label as string,
      pct_t30: b.pct_t30 as number,
      pct_t300: b.pct_t300 as number,
      cost_pct: b.cost_pct as number,
      path_smoothness_0_30: b.path_smoothness_0_30 as number | null,
      bc_velocity_sol_per_min: b.bc_velocity_sol_per_min as number | null,
      top5_wallet_pct: b.top5_wallet_pct as number | null,
      ...Object.fromEntries(CHECKPOINTS.map((cp) => [cp, b[cp] as number | null])),
      liq_t30: b.liquidity_sol_t30 as number | null,
      liq_series,
      swaps: swapsByGrad.get(b.graduation_id as number) ?? [],
    } as WhaleLiqRow;
  });
}

export function evaluateWhaleLiqGrid(
  rows: WhaleLiqRow[],
  universe: UniversePredicate,
  fixedSlPct = 10,
  fixedTpPct = 50,
): { grid: GridCell[]; best: GridCell | null; rows_with_data: number } {
  const liqDropGrid = [20, 30, 40] as const;
  const whaleSellGrid = [0.5, 1, 2] as const;
  const filtered = rows.filter(universe);
  const cells: GridCell[] = [];

  for (const liqDrop of liqDropGrid) {
    for (const whale of whaleSellGrid) {
      const bd = emptyBreakdown();
      let sum = 0, wins = 0, n = 0;
      for (const r of filtered) {
        const out = simulateWhaleLiq(r, {
          stopLossPct: fixedSlPct,
          takeProfitPct: fixedTpPct,
          whaleLiq: { liqDropPct: liqDrop, whaleSellSol: whale },
        });
        if (!out) continue; // row missing entry liquidity
        sum += out.net_return_pct;
        if (out.net_return_pct > 0) wins++;
        bd[out.exit_reason]++;
        n++;
      }
      cells.push({
        params: {
          liq_drop_pct: liqDrop,
          whale_sell_sol: whale,
          sl_pct: fixedSlPct,
          tp_pct: fixedTpPct,
        },
        n,
        avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
        win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
        exit_reason_breakdown: bd,
      });
    }
  }

  let best: GridCell | null = null;
  for (const c of cells) {
    if (c.n < MIN_N_FOR_BEST) continue;
    if (c.avg_return_pct == null) continue;
    if (!best || c.avg_return_pct > (best.avg_return_pct ?? -Infinity)) best = c;
  }
  return { grid: cells, best, rows_with_data: filtered.length };
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
    whale_liq:         { grid: GridCell[]; best: GridCell | null; rows_with_data: number };
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

/**
 * Static SL/TP simulator parameterised on (SL%, TP%). Same cost model as
 * `computeStaticBaseline`, but:
 *   (a) SL/TP are inputs, not hard-coded 10/50
 *   (b) walk INCLUDES pct_t300 — matches `simulateCombo` in aggregates.ts
 *       so matrix cells reconcile with the /api/best-combos leaderboard.
 *       The original computeStaticBaseline stopped at pct_t295 which let
 *       late-breach SL hits fall through to unprotected timeouts.
 *
 * Used by `/api/exit-sim-matrix` to find the per-combo optimal static cell
 * instead of comparing every combo against the global 10/50 default.
 */
export function simulateStaticOnRows(
  rows: ExitSimRow[],
  slPct: number,
  tpPct: number,
): GridCell {
  const breakdown = emptyBreakdown();
  let sum = 0;
  let wins = 0;

  for (const r of rows) {
    const entryRatio = 1 + r.pct_t30 / 100;
    const slLvl = (entryRatio * (1 - slPct / 100) - 1) * 100;
    const tpLvl = (entryRatio * (1 + tpPct / 100) - 1) * 100;
    let exitPct: number | null = null;
    let isSl = false;
    let isTp = false;

    // Walk CHECKPOINTS + pct_t300 so SL/TP at the final checkpoint also trips.
    for (const cp of CHECKPOINTS) {
      const v = r[cp];
      if (v == null) continue;
      if (v <= slLvl) {
        const exitRatio = (1 + v / 100) * (1 - SIM_SL_GAP_PENALTY);
        exitPct = (exitRatio / entryRatio - 1) * 100;
        isSl = true;
        break;
      }
      if (v >= tpLvl) { exitPct = tpPct * (1 - SIM_TP_GAP_PENALTY); isTp = true; break; }
    }
    // Check pct_t300 too before timeout fall-through.
    if (exitPct === null && r.pct_t300 != null) {
      if (r.pct_t300 <= slLvl) {
        const exitRatio = (1 + r.pct_t300 / 100) * (1 - SIM_SL_GAP_PENALTY);
        exitPct = (exitRatio / entryRatio - 1) * 100;
        isSl = true;
      } else if (r.pct_t300 >= tpLvl) {
        exitPct = tpPct * (1 - SIM_TP_GAP_PENALTY);
        isTp = true;
      }
    }
    if (exitPct === null) {
      exitPct = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100;
      breakdown.timeout++;
    } else if (isSl) {
      breakdown.stop_loss++;
    } else if (isTp) {
      breakdown.take_profit++;
    }
    const net = exitPct - r.cost_pct;
    sum += net;
    if (net > 0) wins++;
  }
  const n = rows.length;
  return {
    params: { sl_pct: slPct, tp_pct: tpPct, type: 'static' },
    n,
    avg_return_pct: n > 0 ? +(sum / n).toFixed(2) : null,
    win_rate_pct: n > 0 ? +(wins / n * 100).toFixed(1) : null,
    exit_reason_breakdown: breakdown,
  };
}

export function computeExitSim(
  db: Database.Database,
  opts: { universe?: UniversePredicate; universeLabel?: string; extraWhere?: string } = {},
): ExitSimReport {
  // When `extraWhere` is given, we pre-filter at SQL level and pass a no-op
  // JS predicate to the evaluators. Callers (e.g. /api/exit-sim-matrix) use
  // this to scope the whole report to a single filter-combo universe without
  // duplicating FILTER_CATALOG's SQL as JS predicates.
  const hasExtraWhere = !!(opts.extraWhere && opts.extraWhere.trim().length > 0);
  const universe: UniversePredicate = hasExtraWhere
    ? (() => true)
    : (opts.universe ?? BASELINE_UNIVERSE);
  const universeLabel = opts.universeLabel
    ?? (hasExtraWhere ? 'custom' : 'vel<20 + top5<10% (reference universe)');
  const rows = loadExitSimRows(db, opts.extraWhere);
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
      whale_liq:         evaluateWhaleLiqGrid(loadWhaleLiqRows(db, opts.extraWhere), universe),
    },
  };
}
