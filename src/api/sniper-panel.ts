import Database from 'better-sqlite3';
import { simulateCombo, computeBestCombos, ENTRY_GATE, FILTER_CATALOG } from './aggregates';

/**
 * Sniper-window analytics dashboard. Companion to /api/best-combos focused on
 * the sniper_count_t0_t2 + sniper_wallet_velocity_avg dimension introduced
 * 2026-05.
 *
 * What this panel reports:
 *   - population: how many entry-gated rows have sniper data populated
 *   - threshold sweep: PUMP rate / opt TP·SL / opt_avg_ret at canonical
 *     sniper_count + wallet_velocity thresholds, evaluated with the same
 *     simulateCombo() cost model as /api/best-combos
 *   - histograms: distribution of sniper_count_t0_t2 and
 *     sniper_wallet_velocity_avg across the entry-gated population
 *   - top combos that include a sniper filter (filtered subset of
 *     /api/best-combos so this panel is self-contained)
 */

const SNIPER_FILTER_PREFIXES = ['snipers ', 'wallet_vel_avg'];

function isSniperFilterName(name: string): boolean {
  return SNIPER_FILTER_PREFIXES.some(p => name.startsWith(p));
}

interface ThresholdRow {
  filter: string;
  group: string;
  where: string;
  n: number;
  pump_rate_pct: number | null;
  opt_tp: number | null;
  opt_sl: number | null;
  opt_avg_ret: number | null;
  opt_win_rate: number | null;
}

interface HistogramBucket {
  label: string;
  min: number;
  max: number;
  n: number;
  pct_of_total: number;
}

export interface SniperPanelData {
  generated_at: string;
  population: {
    total_entry_gated: number;
    with_sniper_data: number;
    coverage_pct: number;
  };
  baseline: {
    filter: string;
    n: number;
    opt_tp: number | null;
    opt_sl: number | null;
    opt_avg_ret: number | null;
    opt_win_rate: number | null;
  };
  sniper_count_thresholds: ThresholdRow[];
  wallet_velocity_thresholds: ThresholdRow[];
  sniper_count_histogram: HistogramBucket[];
  wallet_velocity_histogram: HistogramBucket[];
  top_combos_with_sniper: Array<{
    filter_spec: string;
    n: number;
    win_rate_pct: number | null;
    avg_return_t30_to_t300_pct: number | null;
    opt_tp: number | null;
    opt_sl: number | null;
    opt_avg_ret: number | null;
    opt_win_rate: number | null;
    beats_baseline: boolean;
  }>;
  notes: string[];
}

function thresholdSweep(
  db: Database.Database,
  catalog: typeof FILTER_CATALOG,
  group: string,
): ThresholdRow[] {
  const rows: ThresholdRow[] = [];
  for (const f of catalog) {
    if (f.group !== group) continue;
    const result = simulateCombo(db, f.where);
    rows.push({
      filter: f.name,
      group: f.group,
      where: f.where,
      n: result.n,
      pump_rate_pct: result.n > 0 ? +(result.pump / result.n * 100).toFixed(1) : null,
      opt_tp: result.opt_tp,
      opt_sl: result.opt_sl,
      opt_avg_ret: result.opt_avg_ret,
      opt_win_rate: result.opt_win_rate,
    });
  }
  return rows;
}

function histogramFromRows(
  rows: Array<{ value: number | null }>,
  buckets: Array<{ label: string; min: number; max: number }>,
): HistogramBucket[] {
  const total = rows.filter(r => r.value !== null).length;
  return buckets.map(b => {
    const n = rows.filter(r => r.value !== null && r.value >= b.min && r.value < b.max).length;
    return {
      label: b.label,
      min: b.min,
      max: b.max,
      n,
      pct_of_total: total > 0 ? +(n / total * 100).toFixed(1) : 0,
    };
  });
}

export function computeSniperPanel(db: Database.Database): SniperPanelData {
  const generated_at = new Date().toISOString();

  // ── Population coverage ─────────────────────────────────────────────────
  const popRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sniper_count_t0_t2 IS NOT NULL THEN 1 ELSE 0 END) AS with_data
    FROM graduation_momentum
    WHERE ${ENTRY_GATE} AND label IS NOT NULL
  `).get() as { total: number; with_data: number };

  const totalEntry = popRow.total ?? 0;
  const withData = popRow.with_data ?? 0;

  // ── Baseline (no filter) at its own opt TP/SL ───────────────────────────
  const baselineSim = simulateCombo(db, '1=1');

  // ── Threshold sweeps from FILTER_CATALOG ────────────────────────────────
  const sniperCountThresholds = thresholdSweep(db, FILTER_CATALOG, 'Snipers');
  const walletVelThresholds = thresholdSweep(db, FILTER_CATALOG, 'Sniper Vel');

  // ── Histograms ──────────────────────────────────────────────────────────
  const distRows = db.prepare(`
    SELECT sniper_count_t0_t2 AS sc, sniper_wallet_velocity_avg AS sv
    FROM graduation_momentum
    WHERE ${ENTRY_GATE} AND label IS NOT NULL AND sniper_count_t0_t2 IS NOT NULL
  `).all() as Array<{ sc: number | null; sv: number | null }>;

  const sniperCountHistogram = histogramFromRows(
    distRows.map(r => ({ value: r.sc })),
    [
      { label: '0',     min: 0,   max: 1   },
      { label: '1-2',   min: 1,   max: 3   },
      { label: '3-5',   min: 3,   max: 6   },
      { label: '6-10',  min: 6,   max: 11  },
      { label: '11-20', min: 11,  max: 21  },
      { label: '21+',   min: 21,  max: 1e9 },
    ],
  );

  const walletVelHistogram = histogramFromRows(
    distRows.map(r => ({ value: r.sv })),
    [
      { label: '0',     min: 0,    max: 0.5 },
      { label: '<2',    min: 0.5,  max: 2   },
      { label: '2-5',   min: 2,    max: 5   },
      { label: '5-10',  min: 5,    max: 10  },
      { label: '10-20', min: 10,   max: 20  },
      { label: '20+',   min: 20,   max: 1e9 },
    ],
  );

  // ── Top combos that include a sniper filter ─────────────────────────────
  // Reuse computeBestCombos at a wide top so we can filter to sniper-touching
  // rows without re-running the simulator. min_n=20 matches /api/best-combos.
  const wideLeaderboard = computeBestCombos(db, {
    min_n: 20,
    top: 500,
    include_pairs: true,
  });
  const topCombosWithSniper = wideLeaderboard.rows
    .filter(r => r.filters.some(isSniperFilterName))
    .slice(0, 20)
    .map(r => ({
      filter_spec: r.filter_spec,
      n: r.n,
      win_rate_pct: r.win_rate_pct,
      avg_return_t30_to_t300_pct: r.avg_return_t30_to_t300_pct,
      opt_tp: r.opt_tp,
      opt_sl: r.opt_sl,
      opt_avg_ret: r.opt_avg_ret,
      opt_win_rate: r.opt_win_rate,
      beats_baseline: r.beats_baseline,
    }));

  return {
    generated_at,
    population: {
      total_entry_gated: totalEntry,
      with_sniper_data: withData,
      coverage_pct: totalEntry > 0 ? +(withData / totalEntry * 100).toFixed(1) : 0,
    },
    baseline: {
      filter: 'ALL labeled (entry gate only)',
      n: baselineSim.n,
      opt_tp: baselineSim.opt_tp,
      opt_sl: baselineSim.opt_sl,
      opt_avg_ret: baselineSim.opt_avg_ret,
      opt_win_rate: baselineSim.opt_win_rate,
    },
    sniper_count_thresholds: sniperCountThresholds,
    wallet_velocity_thresholds: walletVelThresholds,
    sniper_count_histogram: sniperCountHistogram,
    wallet_velocity_histogram: walletVelHistogram,
    top_combos_with_sniper: topCombosWithSniper,
    notes: [
      'sniper_count_t0_t2 = distinct wallets with a buy in T+0..T+2s window',
      'sniper_wallet_velocity_avg = avg # of EARLIER graduations these snipers also sniped (PRIOR-only by construction)',
      'Both fields written at T+35 alongside buy_pressure_*; strategies using them auto-delay 5s in StrategyManager',
      'Threshold sweeps and top combos use the same simulateCombo() cost model as /api/best-combos (per-combo opt TP/SL across SIM_TP_GRID × SIM_SL_GRID)',
      'beats_baseline column on top combos compares opt_avg_ret to ENTRY_GATE-only baseline + 0.3 pp at n >= 100',
    ],
  };
}
