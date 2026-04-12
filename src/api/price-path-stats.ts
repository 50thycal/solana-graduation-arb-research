/**
 * src/api/price-path-stats.ts
 *
 * Aggregated price path statistics for Claude self-serve via /api/price-path-stats
 * and price-path-stats.json in bot-status branch.
 *
 * Returns compact aggregates — NOT the raw 600-row token table.
 *
 * Sections:
 *   label_counts     — PUMP/DUMP/STABLE n
 *   mean_paths       — mean pct_tN at each checkpoint, per label
 *   feature_effects  — Cohen's d (PUMP vs not-PUMP) for path shape metrics
 *   entry_timing     — avg return when entering at T+5 through T+60 (buying at T+N instead of T+30)
 */

import Database from 'better-sqlite3';

const CHECKPOINTS = ['t5','t10','t15','t20','t25','t30','t35','t40','t45','t50','t55','t60','t90','t120','t150','t180','t240','t300'] as const;
type Checkpoint = typeof CHECKPOINTS[number];

type RawRow = {
  label: 'PUMP' | 'DUMP' | 'STABLE';
  pct_t5: number | null; pct_t10: number | null; pct_t15: number | null;
  pct_t20: number | null; pct_t25: number | null; pct_t30: number | null;
  pct_t35: number | null; pct_t40: number | null; pct_t45: number | null;
  pct_t50: number | null; pct_t55: number | null; pct_t60: number | null;
  pct_t90: number | null; pct_t120: number | null; pct_t150: number | null;
  pct_t180: number | null; pct_t240: number | null; pct_t300: number | null;
  acceleration_t30: number | null;
  monotonicity_0_30: number | null;
  path_smoothness_0_30: number | null;
  max_drawdown_0_30: number | null;
  dip_and_recover_flag: number | null;
  early_vs_late_0_30: number | null;
  bc_velocity_sol_per_min: number | null;
  round_trip_slippage_pct: number | null;
};

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function std(vals: number[]): number {
  if (vals.length < 2) return 0;
  const m = mean(vals);
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
}

function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const mA = mean(a), mB = mean(b);
  const sA = std(a), sB = std(b);
  const pooled = Math.sqrt((sA ** 2 + sB ** 2) / 2);
  if (pooled === 0) return null;
  return +((mA - mB) / pooled).toFixed(3);
}

function round2(v: number | null): number | null {
  return v === null ? null : +v.toFixed(2);
}

export interface PricePathStats {
  generated_at: string;
  label_counts: { PUMP: number; DUMP: number; STABLE: number; total: number };
  mean_paths: {
    PUMP: Record<Checkpoint, number | null>;
    DUMP: Record<Checkpoint, number | null>;
    STABLE: Record<Checkpoint, number | null>;
    ALL: Record<Checkpoint, number | null>;
  };
  feature_effects: Array<{
    feature: string;
    pump_mean: number | null;
    notpump_mean: number | null;
    cohens_d: number | null;
    interpretation: string;
  }>;
  entry_timing: Array<{
    entry_sec: number;
    n: number;
    avg_raw_return_pct: number | null;
    notes: string;
  }>;
  velocity_breakdown: Array<{
    bucket: string;
    n: number;
    pump_rate_pct: number;
    pump_mean_return: number | null;
  }>;
}

export function computePricePathStats(db: Database.Database): PricePathStats {
  const rows = db.prepare(`
    SELECT label,
      pct_t5, pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
      pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
      pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300,
      acceleration_t30, monotonicity_0_30, path_smoothness_0_30,
      max_drawdown_0_30, dip_and_recover_flag, early_vs_late_0_30,
      bc_velocity_sol_per_min,
      COALESCE(round_trip_slippage_pct, 3.0) as round_trip_slippage_pct
    FROM graduation_momentum
    WHERE label IS NOT NULL AND pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
    ORDER BY graduation_id DESC
    LIMIT 600
  `).all() as RawRow[];

  // ── Label counts ──
  const pumps  = rows.filter(r => r.label === 'PUMP');
  const dumps  = rows.filter(r => r.label === 'DUMP');
  const stables = rows.filter(r => r.label === 'STABLE');
  const label_counts = {
    PUMP: pumps.length, DUMP: dumps.length, STABLE: stables.length, total: rows.length,
  };

  // ── Mean paths per label ──
  const labelGroups: Record<string, RawRow[]> = { PUMP: pumps, DUMP: dumps, STABLE: stables, ALL: rows };
  const mean_paths = {} as PricePathStats['mean_paths'];
  for (const [label, group] of Object.entries(labelGroups)) {
    const pathRow = {} as Record<Checkpoint, number | null>;
    for (const cp of CHECKPOINTS) {
      const vals = group.map(r => r[`pct_${cp}` as keyof RawRow] as number | null).filter(v => v !== null) as number[];
      pathRow[cp] = vals.length >= 3 ? round2(mean(vals)) : null;
    }
    (mean_paths as any)[label] = pathRow;
  }

  // ── Feature effects (Cohen's d: PUMP vs notPUMP) ──
  const notPumps = rows.filter(r => r.label !== 'PUMP');
  const features: Array<{ key: keyof RawRow; label: string }> = [
    { key: 'acceleration_t30',   label: 'acceleration_t30' },
    { key: 'monotonicity_0_30',  label: 'monotonicity_0_30' },
    { key: 'path_smoothness_0_30', label: 'path_smoothness_0_30' },
    { key: 'max_drawdown_0_30',  label: 'max_drawdown_0_30' },
    { key: 'dip_and_recover_flag', label: 'dip_and_recover_flag' },
    { key: 'early_vs_late_0_30', label: 'early_vs_late_0_30' },
  ];
  const feature_effects = features.map(({ key, label }) => {
    const pVals  = pumps.map(r => r[key] as number | null).filter(v => v !== null) as number[];
    const npVals = notPumps.map(r => r[key] as number | null).filter(v => v !== null) as number[];
    const d = cohensD(pVals, npVals);
    const absD = d === null ? 0 : Math.abs(d);
    const interpretation = absD >= 0.8 ? 'large' : absD >= 0.5 ? 'medium' : absD >= 0.2 ? 'small' : 'negligible';
    return {
      feature: label,
      pump_mean: round2(pVals.length >= 3 ? mean(pVals) : null),
      notpump_mean: round2(npVals.length >= 3 ? mean(npVals) : null),
      cohens_d: d,
      interpretation,
    };
  });
  feature_effects.sort((a, b) => Math.abs(b.cohens_d ?? 0) - Math.abs(a.cohens_d ?? 0));

  // ── Entry timing: what happens if we enter at T+N instead of T+30? ──
  // For each entry offset, compute avg return = (pct_t300 - pct_tN) / (1 + pct_tN/100) - cost
  const entryPoints: Array<{ sec: number; col: keyof RawRow }> = [
    { sec: 5,  col: 'pct_t5' },
    { sec: 10, col: 'pct_t10' },
    { sec: 15, col: 'pct_t15' },
    { sec: 20, col: 'pct_t20' },
    { sec: 25, col: 'pct_t25' },
    { sec: 30, col: 'pct_t30' },
    { sec: 40, col: 'pct_t40' },
    { sec: 45, col: 'pct_t45' },
    { sec: 60, col: 'pct_t60' },
  ];
  const entry_timing = entryPoints.map(({ sec, col }) => {
    const valid = rows.filter(r => (r[col] as number | null) !== null);
    const returns = valid.map(r => {
      const entryPct = r[col] as number;
      const exitPct  = r.pct_t300 as number;
      const cost     = r.round_trip_slippage_pct;
      return ((1 + exitPct / 100) / (1 + entryPct / 100) - 1) * 100 - cost;
    });
    const avgRet = returns.length >= 5 ? round2(mean(returns)) : null;
    return {
      entry_sec: sec,
      n: returns.length,
      avg_raw_return_pct: avgRet,
      notes: sec === 30 ? 'current entry (baseline)' : sec < 30 ? 'earlier entry' : 'later entry',
    };
  });

  // ── Velocity breakdown ──
  const velBuckets: Array<{ label: string; filter: (r: RawRow) => boolean }> = [
    { label: 'vel < 5',    filter: r => r.bc_velocity_sol_per_min !== null && r.bc_velocity_sol_per_min < 5 },
    { label: 'vel 5-20',   filter: r => r.bc_velocity_sol_per_min !== null && r.bc_velocity_sol_per_min >= 5  && r.bc_velocity_sol_per_min < 20 },
    { label: 'vel 20-50',  filter: r => r.bc_velocity_sol_per_min !== null && r.bc_velocity_sol_per_min >= 20 && r.bc_velocity_sol_per_min < 50 },
    { label: 'vel 50-200', filter: r => r.bc_velocity_sol_per_min !== null && r.bc_velocity_sol_per_min >= 50 && r.bc_velocity_sol_per_min < 200 },
    { label: 'vel > 200',  filter: r => r.bc_velocity_sol_per_min !== null && r.bc_velocity_sol_per_min >= 200 },
  ];
  const velocity_breakdown = velBuckets.map(({ label, filter: f }) => {
    const subset = rows.filter(f);
    const subPumps = subset.filter(r => r.label === 'PUMP');
    const pumpReturns = subPumps.map(r => r.pct_t300 as number);
    return {
      bucket: label,
      n: subset.length,
      pump_rate_pct: subset.length > 0 ? +((subPumps.length / subset.length) * 100).toFixed(1) : 0,
      pump_mean_return: pumpReturns.length >= 3 ? round2(mean(pumpReturns)) : null,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    label_counts,
    mean_paths,
    feature_effects,
    entry_timing,
    velocity_breakdown,
  };
}
