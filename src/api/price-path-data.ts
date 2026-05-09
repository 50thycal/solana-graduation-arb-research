/**
 * src/api/price-path-data.ts
 *
 * Pure data computation for the /price-path dashboard. Returns a structured
 * PricePathData object exposed as JSON via /api/price-path-detail and the
 * bot-status sync (price-path-detail.json).
 *
 * Covers all 8 sections rendered by renderPricePathHtml:
 *   1. data_status      — counts by label + vel 5-20 subset
 *   2. overlay          — raw per-token paths (≤200 tokens)
 *   3. avg_by_label     — mean paths + ±1 SD for PUMP/DUMP/STABLE
 *   4. vel520_vs_all    — mean paths: vel 5-20 vs all, per label
 *   5. derived_metrics  — Cohen's d effect sizes (PUMP vs DUMP)
 *   6. acceleration_histogram — bin counts for acceleration_t30
 *   7. entry_timing_heatmap   — 10%SL/50%TP sim at each T+5..T+60 entry
 *   8. win_rate_by_monotonicity — WR across monotonicity buckets
 *
 * SQL/math duplicated with renderPricePathHtml by design — that function stays
 * unchanged to avoid breaking the existing HTML page. Consolidation can come
 * later; keeping both paths independent minimizes rollout risk.
 */

import type Database from 'better-sqlite3';

const TIME_POINTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;

const SL_GAP = 0.30;
const TP_GAP = 0.10;
const FALLBACK_COST = 3.0;
const ENTRY_SIM_SL = 10;
const ENTRY_SIM_TP = 50;
const ENTRY_SIM_MIN = 5;
const ENTRY_SIM_MAX = 100;

function meanPcts(rows: any[]): (number | null)[] {
  return TIME_POINTS.map((_, i) => {
    const col = `pct_t${TIME_POINTS[i]}`;
    const vals = rows.map(r => (TIME_POINTS[i] === 0 ? 0 : r[col] as number | null))
      .filter(v => v != null) as number[];
    return vals.length > 0 ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : null;
  });
}

function stdDevPcts(rows: any[], means: (number | null)[]): (number | null)[] {
  return TIME_POINTS.map((_, i) => {
    const col = `pct_t${TIME_POINTS[i]}`;
    const m = means[i];
    if (m == null) return null;
    const vals = rows.map(r => (TIME_POINTS[i] === 0 ? 0 : r[col] as number | null))
      .filter(v => v != null) as number[];
    if (vals.length < 2) return null;
    const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    return +Math.sqrt(variance).toFixed(3);
  });
}

function simulateEntryAtTime(
  rows: any[], entryCol: string, slPct: number, tpPct: number,
  minEntry: number, maxEntry: number,
): { n: number; avg_return: number; win_rate: number } {
  let total = 0, count = 0, wins = 0;
  const allCps = ['pct_t5','pct_t10','pct_t15','pct_t20','pct_t25','pct_t30',
                  'pct_t35','pct_t40','pct_t45','pct_t50','pct_t55','pct_t60',
                  'pct_t90','pct_t120','pct_t150','pct_t180','pct_t240'] as const;
  for (const r of rows) {
    const entryPct: number | null = entryCol === 'pct_t0' ? 0 : r[entryCol];
    if (entryPct == null || entryPct < minEntry || entryPct > maxEntry) continue;
    const openMult = 1 + entryPct / 100;
    const slLevel = (openMult * (1 - slPct / 100) - 1) * 100;
    const tpLevel = (openMult * (1 + tpPct / 100) - 1) * 100;
    const cost = r.round_trip_slippage_pct ?? FALLBACK_COST;
    const entryIdx = allCps.indexOf(entryCol as any);
    let exit: number | null = null;
    for (let ci = entryIdx + 1; ci < allCps.length; ci++) {
      const cpv: number | null = r[allCps[ci]];
      if (cpv == null) continue;
      if (cpv <= slLevel) {
        const exitRatio = (1 + cpv / 100) * (1 - SL_GAP);
        exit = (exitRatio / openMult - 1) * 100;
        break;
      }
      if (cpv >= tpLevel) { exit = tpPct * (1 - TP_GAP); break; }
    }
    if (exit == null) {
      exit = r.pct_t300 != null
        ? ((1 + r.pct_t300 / 100) / (1 + entryPct / 100) - 1) * 100
        : -100;
    }
    const net = exit - cost;
    total += net;
    count++;
    if (net > 0) wins++;
  }
  if (count === 0) return { n: 0, avg_return: 0, win_rate: 0 };
  return { n: count, avg_return: +(total / count).toFixed(2), win_rate: +(wins / count * 100).toFixed(1) };
}

function avgMetric(rows: any[], col: string): number | null {
  const vals = rows.map(r => r[col] as number | null).filter(v => v != null) as number[];
  if (vals.length === 0) return null;
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
}

function cohensD(p: any[], d: any[], col: string): number | null {
  const pv = p.map(r => r[col] as number | null).filter(v => v != null) as number[];
  const dv = d.map(r => r[col] as number | null).filter(v => v != null) as number[];
  if (pv.length < 2 || dv.length < 2) return null;
  const pm = pv.reduce((a, b) => a + b, 0) / pv.length;
  const dm = dv.reduce((a, b) => a + b, 0) / dv.length;
  const pv2 = pv.reduce((a, b) => a + (b - pm) ** 2, 0) / pv.length;
  const dv2 = dv.reduce((a, b) => a + (b - dm) ** 2, 0) / dv.length;
  const pooledSD = Math.sqrt((pv2 + dv2) / 2);
  if (pooledSD === 0) return null;
  return +(Math.abs(pm - dm) / pooledSD).toFixed(3);
}

export function computePricePathData(db: Database.Database) {
  // ── 1. Load labeled tokens (complete 5s data) ──
  const allTokens = db.prepare(`
    SELECT label, bc_velocity_sol_per_min, round_trip_slippage_pct,
           pct_t5,  pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
           pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
           pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300,
           acceleration_t30, acceleration_t60,
           monotonicity_0_30, monotonicity_0_60,
           path_smoothness_0_30, path_smoothness_0_60,
           max_drawdown_0_30, max_drawdown_0_60,
           dip_and_recover_flag, early_vs_late_0_30, early_vs_late_0_60
    FROM graduation_momentum
    WHERE pct_t5 IS NOT NULL AND pct_t10 IS NOT NULL
      AND pct_t30 IS NOT NULL AND pct_t60 IS NOT NULL
      AND label IS NOT NULL
    ORDER BY id DESC
    LIMIT 600
  `).all() as any[];

  const total5s = (db.prepare(`
    SELECT COUNT(*) as n FROM graduation_momentum
    WHERE pct_t5 IS NOT NULL AND pct_t60 IS NOT NULL
  `).get() as any)?.n ?? 0;

  const labeled = allTokens.filter(r => r.label != null);
  const pumps   = labeled.filter(r => r.label === 'PUMP');
  const dumps   = labeled.filter(r => r.label === 'DUMP');
  const stables = labeled.filter(r => r.label === 'STABLE');
  const vel520  = labeled.filter(r => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20);
  const vel520P = vel520.filter(r => r.label === 'PUMP');
  const vel520D = vel520.filter(r => r.label === 'DUMP');

  // ── 2. Raw per-token overlay (≤200) ──
  const overlayTokens = labeled.slice(0, 200).map(r => ({
    label: r.label as string,
    bc_velocity_sol_per_min: r.bc_velocity_sol_per_min as number | null,
    pcts: TIME_POINTS.map(t => t === 0 ? 0 : (r[`pct_t${t}`] as number | null)),
  }));

  // ── 3. Average path by label with ±1 SD ──
  const avgPump   = meanPcts(pumps);
  const avgDump   = meanPcts(dumps);
  const avgStable = meanPcts(stables);
  const sdPump    = stdDevPcts(pumps, avgPump);
  const sdDump    = stdDevPcts(dumps, avgDump);

  // ── 4. Vel 5-20 vs all ──
  const avgAllP = avgPump;
  const avgAllD = avgDump;
  const avgV5P  = meanPcts(vel520P);
  const avgV5D  = meanPcts(vel520D);

  // ── 5. Derived metrics / Cohen's d ──
  const METRIC_COLS: Array<[string, string]> = [
    ['acceleration_t30',    'Acceleration at T+30'],
    ['acceleration_t60',    'Acceleration at T+60'],
    ['monotonicity_0_30',   'Monotonicity 0-30s (0-1)'],
    ['monotonicity_0_60',   'Monotonicity 0-60s (0-1)'],
    ['path_smoothness_0_30','Path Smoothness 0-30s (SD)'],
    ['path_smoothness_0_60','Path Smoothness 0-60s (SD)'],
    ['max_drawdown_0_30',   'Max Drawdown 0-30s (%)'],
    ['max_drawdown_0_60',   'Max Drawdown 0-60s (%)'],
    ['early_vs_late_0_30',  'Early vs Late 0-30s'],
    ['early_vs_late_0_60',  'Early vs Late 0-60s'],
  ];
  const derivedMetrics: Record<string, { label: string; pump_avg: number | null; dump_avg: number | null; stable_avg: number | null; cohens_d: number | null; pump_n: number; dump_n: number; stable_n: number }> = {};
  for (const [col, label] of METRIC_COLS) {
    derivedMetrics[col] = {
      label,
      pump_avg:   avgMetric(pumps,   col),
      dump_avg:   avgMetric(dumps,   col),
      stable_avg: avgMetric(stables, col),
      cohens_d:   cohensD(pumps, dumps, col),
      pump_n:   pumps.filter(r => r[col] != null).length,
      dump_n:   dumps.filter(r => r[col] != null).length,
      stable_n: stables.filter(r => r[col] != null).length,
    };
  }
  const pDip = pumps.filter(r => r.dip_and_recover_flag === 1).length;
  const dDip = dumps.filter(r => r.dip_and_recover_flag === 1).length;
  const sDip = stables.filter(r => r.dip_and_recover_flag === 1).length;
  derivedMetrics['dip_and_recover_flag'] = {
    label: 'Dip & Recover % (flag=1)',
    pump_avg:   pumps.length   > 0 ? +(pDip / pumps.length   * 100).toFixed(1) : null,
    dump_avg:   dumps.length   > 0 ? +(dDip / dumps.length   * 100).toFixed(1) : null,
    stable_avg: stables.length > 0 ? +(sDip / stables.length * 100).toFixed(1) : null,
    cohens_d:   null,
    pump_n: pumps.length,
    dump_n: dumps.length,
    stable_n: stables.length,
  };

  // ── 6. Acceleration histogram ──
  const pumpAcc = pumps.map(r => r.acceleration_t30 as number | null).filter(v => v != null) as number[];
  const dumpAcc = dumps.map(r => r.acceleration_t30 as number | null).filter(v => v != null) as number[];
  let accHist: {
    bin_count: number; bin_min: number; bin_max: number;
    bin_edges: number[]; pump_bins: number[]; dump_bins: number[];
    pump_n: number; dump_n: number;
  } | null = null;
  if (pumpAcc.length > 0 || dumpAcc.length > 0) {
    const allAcc = [...pumpAcc, ...dumpAcc];
    const accMin = Math.max(Math.min(...allAcc), -100);
    const accMax = Math.min(Math.max(...allAcc),  100);
    const BIN_COUNT = 14;
    const binW = (accMax - accMin) / BIN_COUNT;
    const pBins = new Array(BIN_COUNT).fill(0);
    const dBins = new Array(BIN_COUNT).fill(0);
    for (const v of pumpAcc) {
      const idx = Math.min(Math.floor((v - accMin) / binW), BIN_COUNT - 1);
      if (idx >= 0) pBins[idx]++;
    }
    for (const v of dumpAcc) {
      const idx = Math.min(Math.floor((v - accMin) / binW), BIN_COUNT - 1);
      if (idx >= 0) dBins[idx]++;
    }
    const binEdges = Array.from({ length: BIN_COUNT + 1 }, (_, i) => +(accMin + i * binW).toFixed(2));
    accHist = {
      bin_count: BIN_COUNT,
      bin_min: +accMin.toFixed(2),
      bin_max: +accMax.toFixed(2),
      bin_edges: binEdges,
      pump_bins: pBins,
      dump_bins: dBins,
      pump_n: pumpAcc.length,
      dump_n: dumpAcc.length,
    };
  }

  // ── 7. Entry timing heatmap ──
  const entryTimes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  const simRows = db.prepare(`
    SELECT label, bc_velocity_sol_per_min, round_trip_slippage_pct,
           pct_t5,  pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
           pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
           pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300
    FROM graduation_momentum
    WHERE label IS NOT NULL
  `).all() as any[];
  const simRowsVel520 = simRows.filter(
    r => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20,
  );
  const heatmapRows: Array<{
    entry_time: string;
    all: { n: number; win_rate: number; avg_return: number };
    vel520: { n: number; win_rate: number; avg_return: number };
  }> = [];
  let bestAllTime = '—', bestAllReturn = -Infinity;
  let bestVelTime = '—', bestVelReturn = -Infinity;
  for (const t of entryTimes) {
    const col = `pct_t${t}`;
    const rAll = simulateEntryAtTime(simRows,       col, ENTRY_SIM_SL, ENTRY_SIM_TP, ENTRY_SIM_MIN, ENTRY_SIM_MAX);
    const rVel = simulateEntryAtTime(simRowsVel520, col, ENTRY_SIM_SL, ENTRY_SIM_TP, ENTRY_SIM_MIN, ENTRY_SIM_MAX);
    heatmapRows.push({ entry_time: `T+${t}s`, all: rAll, vel520: rVel });
    if (rAll.n >= 20 && rAll.avg_return > bestAllReturn) {
      bestAllReturn = rAll.avg_return; bestAllTime = `T+${t}s`;
    }
    if (rVel.n >= 10 && rVel.avg_return > bestVelReturn) {
      bestVelReturn = rVel.avg_return; bestVelTime = `T+${t}s`;
    }
  }

  // ── 8. Monotonicity breakdown ──
  const monoBuckets = [
    { label: '0-33% (choppy)',    min: 0,     max: 0.334 },
    { label: '33-67% (mixed)',    min: 0.334, max: 0.667 },
    { label: '67-100% (smooth)',  min: 0.667, max: 1.001 },
  ];
  const monotonicityBuckets = monoBuckets.map(b => {
    const inBucket = labeled.filter(r => r.monotonicity_0_30 != null && r.monotonicity_0_30 >= b.min && r.monotonicity_0_30 < b.max);
    const bPump = inBucket.filter(r => r.label === 'PUMP').length;
    const bDump = inBucket.filter(r => r.label === 'DUMP').length;
    const bN    = inBucket.length;
    const vSub  = inBucket.filter(r => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20);
    const vN    = vSub.length;
    const vP    = vSub.filter(r => r.label === 'PUMP').length;
    return {
      bucket: b.label,
      n: bN,
      pump: bPump,
      dump: bDump,
      win_rate_pct: bN > 0 ? +(bPump / bN * 100).toFixed(1) : null,
      vel520_n: vN,
      vel520_win_rate_pct: vN > 0 ? +(vP / vN * 100).toFixed(1) : null,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    data_status: {
      total_5s_tokens: total5s,
      labeled_count: labeled.length,
      by_label: { PUMP: pumps.length, DUMP: dumps.length, STABLE: stables.length },
      vel520_count: vel520.length,
      vel520_pump: vel520P.length,
      vel520_dump: vel520D.length,
    },
    time_points: [...TIME_POINTS],
    overlay: {
      token_count: overlayTokens.length,
      tokens: overlayTokens,
    },
    avg_by_label: {
      pump:   { mean: avgPump,   sd: sdPump, n: pumps.length },
      dump:   { mean: avgDump,   sd: sdDump, n: dumps.length },
      stable: { mean: avgStable, n: stables.length },
    },
    vel520_vs_all: {
      all_pump_mean: avgAllP,
      all_dump_mean: avgAllD,
      vel520_pump_mean: avgV5P,
      vel520_dump_mean: avgV5D,
      all_pump_n: pumps.length,
      all_dump_n: dumps.length,
      vel520_pump_n: vel520P.length,
      vel520_dump_n: vel520D.length,
    },
    derived_metrics: derivedMetrics,
    acceleration_histogram: accHist,
    entry_timing_heatmap: {
      sl_pct: ENTRY_SIM_SL,
      tp_pct: ENTRY_SIM_TP,
      entry_gate_min_pct: ENTRY_SIM_MIN,
      entry_gate_max_pct: ENTRY_SIM_MAX,
      rows: heatmapRows,
      best_all:    { entry_time: bestAllTime, avg_return: bestAllReturn === -Infinity ? null : bestAllReturn },
      best_vel520: { entry_time: bestVelTime, avg_return: bestVelReturn === -Infinity ? null : bestVelReturn },
    },
    win_rate_by_monotonicity: monotonicityBuckets,
  };
}

export type PricePathData = ReturnType<typeof computePricePathData>;
