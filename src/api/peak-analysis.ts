/**
 * src/api/peak-analysis.ts
 *
 * Peak return diagnostics — all computation for the /peak-analysis page and
 * /api/peak-analysis JSON endpoint.
 *
 * max_relret_0_300 is look-ahead: it records the highest %-return from the T+30
 * entry price reached at any point in 0-300s. It is NOT a tradable filter. This
 * module exposes it for three diagnostic purposes:
 *
 *   1. CDF — what % of tokens ever reach each peak level? Answers "where should
 *      TP be set to maximize hit_rate × TP?"
 *   2. Peak-time histogram — when do peaks occur? Informs maxHoldSeconds and
 *      trailing-TP calibration.
 *   3. Per-filter peak bucket table — for each early-only filter, what fraction
 *      of its matching rows peak in each bucket? Answers "does my filter
 *      actually select tokens that move?"
 *   4. Suggested TP — given the baseline CDF and fixed gap/cost assumptions,
 *      argmax over a TP grid of hit_rate × (tp × 0.9 − cost).
 */

import Database from 'better-sqlite3';

const ENTRY_GATE_MIN = 5;
const ENTRY_GATE_MAX = 100;
const ROUND_TRIP_COST_PCT = 3.0;
const TP_GAP_PENALTY = 0.10; // mirrors Panel 4 / position-manager assumption

// TP grid to evaluate for the "suggested TP" panel. Same granularity as
// PANEL_4_TP_GRID (src/index.ts) except we only care about realistic values.
const TP_GRID = [15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 100] as const;

// Peak buckets used across CDF and per-filter breakdowns. Keep aligned with
// the thresholds a trader would care about.
const PEAK_THRESHOLDS = [10, 20, 30, 40, 50, 75, 100, 150] as const;

// Bucket bins for the peak-time histogram. Seconds since graduation.
// (T+30 is entry — anything earlier isn't eligible for peak-from-entry.)
const PEAK_TIME_BINS: Array<{ label: string; min: number; max: number }> = [
  { label: '30-45s',   min: 30,  max: 45  },
  { label: '45-60s',   min: 45,  max: 60  },
  { label: '60-90s',   min: 60,  max: 90  },
  { label: '90-120s',  min: 90,  max: 120 },
  { label: '120-180s', min: 120, max: 180 },
  { label: '180-240s', min: 180, max: 240 },
  { label: '240-300s', min: 240, max: 301 },
];

interface PeakRow {
  pct_t30: number;
  pct_t300: number;
  cost_pct: number;
  max_relret_0_300: number;
  max_relret_0_300_sec: number;
  // Early-only fields for per-filter bucketing
  bc_velocity_sol_per_min: number | null;
  token_age_seconds: number | null;
  holder_count: number | null;
  top5_wallet_pct: number | null;
  dev_wallet_pct: number | null;
  liquidity_sol_t30: number | null;
  monotonicity_0_30: number | null;
  max_drawdown_0_30: number | null;
  acceleration_t30: number | null;
  buy_pressure_buy_ratio: number | null;
  buy_pressure_unique_buyers: number | null;
  buy_pressure_whale_pct: number | null;
  creator_prior_token_count: number | null;
  creator_prior_rug_rate: number | null;
  creator_last_token_age_hours: number | null;
}

// Early-only filter predicates — mirrors PANEL_1_FILTERS but excludes anything
// computed from post-entry data (which would be look-ahead). Used for the
// per-filter peak-bucket table.
const EARLY_FILTERS: Array<{ name: string; group: string; predicate: (r: PeakRow) => boolean }> = [
  // Velocity
  { name: 'vel < 5',    group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 5 },
  { name: 'vel 5-10',   group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 10 },
  { name: 'vel 5-20',   group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20 },
  { name: 'vel 10-20',  group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 10 && r.bc_velocity_sol_per_min < 20 },
  { name: 'vel < 20',   group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20 },
  { name: 'vel 20-50',  group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 20 && r.bc_velocity_sol_per_min < 50 },
  { name: 'vel 50-200', group: 'Velocity', predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 50 && r.bc_velocity_sol_per_min < 200 },
  // BC Age
  { name: 'age < 10min', group: 'BC Age', predicate: (r) => r.token_age_seconds != null && r.token_age_seconds < 600 },
  { name: 'age > 10min', group: 'BC Age', predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 600 },
  { name: 'age > 30min', group: 'BC Age', predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 1800 },
  { name: 'age > 1hr',   group: 'BC Age', predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 3600 },
  // Holders
  { name: 'holders >= 5',  group: 'Holders', predicate: (r) => r.holder_count != null && r.holder_count >= 5 },
  { name: 'holders >= 10', group: 'Holders', predicate: (r) => r.holder_count != null && r.holder_count >= 10 },
  { name: 'holders >= 15', group: 'Holders', predicate: (r) => r.holder_count != null && r.holder_count >= 15 },
  { name: 'holders >= 18', group: 'Holders', predicate: (r) => r.holder_count != null && r.holder_count >= 18 },
  // Top 5
  { name: 'top5 < 10%', group: 'Top 5',  predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 10 },
  { name: 'top5 < 15%', group: 'Top 5',  predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 15 },
  { name: 'top5 < 20%', group: 'Top 5',  predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 20 },
  // Liquidity
  { name: 'liq > 50',  group: 'Liquidity', predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 50 },
  { name: 'liq > 100', group: 'Liquidity', predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 100 },
  { name: 'liq > 150', group: 'Liquidity', predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 150 },
  // Path shape
  { name: 'mono > 0.5',  group: 'Path Mono', predicate: (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.5 },
  { name: 'mono > 0.66', group: 'Path Mono', predicate: (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.66 },
  { name: 'dd > -10%',   group: 'Path DD',   predicate: (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -10 },
  { name: 'dd > -20%',   group: 'Path DD',   predicate: (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -20 },
  { name: 'accel > 0',   group: 'Path',      predicate: (r) => r.acceleration_t30 != null && r.acceleration_t30 > 0 },
  // Buy pressure
  { name: 'buy_ratio > 0.5', group: 'Buy Pressure', predicate: (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.5 },
  { name: 'buy_ratio > 0.6', group: 'Buy Pressure', predicate: (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.6 },
  { name: 'buyers >= 5',     group: 'Buy Pressure', predicate: (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 5 },
  { name: 'buyers >= 10',    group: 'Buy Pressure', predicate: (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 10 },
  { name: 'whale < 30%',     group: 'Buy Pressure', predicate: (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 30 },
  { name: 'whale < 50%',     group: 'Buy Pressure', predicate: (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 50 },
  // Creator
  { name: 'fresh_dev',       group: 'Creator Rep', predicate: (r) => r.creator_prior_token_count != null && r.creator_prior_token_count === 0 },
  { name: 'repeat_dev >= 3', group: 'Creator Rep', predicate: (r) => r.creator_prior_token_count != null && r.creator_prior_token_count >= 3 },
  { name: 'clean_dev',       group: 'Creator Rep', predicate: (r) => r.creator_prior_rug_rate != null && r.creator_prior_rug_rate < 0.3 },
  // Current baseline combo (kept separate group so it stands out)
  { name: 'baseline: vel<20 + top5<10%', group: 'Baseline', predicate: (r) =>
      r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20 &&
      r.top5_wallet_pct != null && r.top5_wallet_pct < 10 },
];

export interface PeakBucketRow {
  filter: string;
  group: string;
  n: number;
  // pct of n reaching each threshold (look-ahead — diagnostic only)
  pct_reach: Record<string, number | null>; // key = threshold like "20", "40", etc.
  median_peak: number | null;
  p25_peak: number | null;
  p75_peak: number | null;
  avg_final_return: number | null; // avg pct_t300-from-entry (tradable outcome)
}

export interface PeakAnalysisData {
  generated_at: string;
  disclaimer: string;
  n_total: number;
  n_baseline: number;
  // Panel A: CDF of max_relret_0_300 (baseline + all-labeled overlay)
  cdf: {
    threshold_pct: number;
    all_reach_pct: number;      // % of n_total reaching this peak
    baseline_reach_pct: number; // % of n_baseline reaching this peak
  }[];
  // Panel B: histogram of peak time
  peak_time_histogram: {
    bin: string;
    all_count: number;
    all_pct: number;
    baseline_count: number;
    baseline_pct: number;
  }[];
  // Panel C: per-filter peak-bucket table
  per_filter: PeakBucketRow[];
  // Panel D: suggested TP
  suggested_tp: {
    tp_pct: number;
    hit_rate_pct: number;
    avg_nonhit_return_pct: number;
    expected_return_pct: number; // hit_rate * (tp * (1-gap) - cost) + (1-hit_rate) * (nonhit - cost)
  }[];
  recommended_tp: { tp_pct: number; expected_return_pct: number } | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computePeakAnalysis(db: Database.Database): PeakAnalysisData {
  const rows = db.prepare(`
    SELECT pct_t30, pct_t300,
           COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct,
           max_relret_0_300, max_relret_0_300_sec,
           bc_velocity_sol_per_min, token_age_seconds, holder_count, top5_wallet_pct,
           dev_wallet_pct, liquidity_sol_t30, monotonicity_0_30, max_drawdown_0_30,
           acceleration_t30, buy_pressure_buy_ratio, buy_pressure_unique_buyers,
           buy_pressure_whale_pct, creator_prior_token_count, creator_prior_rug_rate,
           creator_last_token_age_hours
    FROM graduation_momentum
    WHERE label IS NOT NULL
      AND pct_t30 IS NOT NULL
      AND pct_t30 >= ${ENTRY_GATE_MIN}
      AND pct_t30 <= ${ENTRY_GATE_MAX}
      AND pct_t300 IS NOT NULL
      AND max_relret_0_300 IS NOT NULL
  `).all() as PeakRow[];

  const baseline = rows.filter((r) =>
    r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20 &&
    r.top5_wallet_pct != null && r.top5_wallet_pct < 10,
  );

  const nTotal = rows.length;
  const nBaseline = baseline.length;

  // ── Panel A: CDF ────────────────────────────────────────────────────
  const cdf = PEAK_THRESHOLDS.map((t) => {
    const allHits = rows.reduce((s, r) => s + (r.max_relret_0_300 >= t ? 1 : 0), 0);
    const baseHits = baseline.reduce((s, r) => s + (r.max_relret_0_300 >= t ? 1 : 0), 0);
    return {
      threshold_pct: t,
      all_reach_pct: nTotal > 0 ? +(allHits / nTotal * 100).toFixed(1) : 0,
      baseline_reach_pct: nBaseline > 0 ? +(baseHits / nBaseline * 100).toFixed(1) : 0,
    };
  });

  // ── Panel B: peak-time histogram ─────────────────────────────────────
  const peakTimeHistogram = PEAK_TIME_BINS.map((bin) => {
    const allCount = rows.reduce((s, r) => s + (r.max_relret_0_300_sec >= bin.min && r.max_relret_0_300_sec < bin.max ? 1 : 0), 0);
    const baseCount = baseline.reduce((s, r) => s + (r.max_relret_0_300_sec >= bin.min && r.max_relret_0_300_sec < bin.max ? 1 : 0), 0);
    return {
      bin: bin.label,
      all_count: allCount,
      all_pct: nTotal > 0 ? +(allCount / nTotal * 100).toFixed(1) : 0,
      baseline_count: baseCount,
      baseline_pct: nBaseline > 0 ? +(baseCount / nBaseline * 100).toFixed(1) : 0,
    };
  });

  // ── Panel C: per-filter peak-bucket table ────────────────────────────
  const perFilter: PeakBucketRow[] = EARLY_FILTERS.map(({ name, group, predicate }) => {
    const matched = rows.filter(predicate);
    const n = matched.length;
    const peaks = matched.map((r) => r.max_relret_0_300).sort((a, b) => a - b);
    const pctReach: Record<string, number | null> = {};
    for (const t of PEAK_THRESHOLDS) {
      pctReach[String(t)] = n > 0
        ? +(matched.reduce((s, r) => s + (r.max_relret_0_300 >= t ? 1 : 0), 0) / n * 100).toFixed(1)
        : null;
    }
    let avgFinal: number | null = null;
    if (n > 0) {
      const finals = matched.map((r) => ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100);
      avgFinal = +(finals.reduce((s, v) => s + v, 0) / finals.length).toFixed(2);
    }
    return {
      filter: name,
      group,
      n,
      pct_reach: pctReach,
      median_peak: n > 0 ? +((percentile(peaks, 50) ?? 0).toFixed(2)) : null,
      p25_peak:    n > 0 ? +((percentile(peaks, 25) ?? 0).toFixed(2)) : null,
      p75_peak:    n > 0 ? +((percentile(peaks, 75) ?? 0).toFixed(2)) : null,
      avg_final_return: avgFinal,
    };
  });

  // ── Panel D: suggested TP ────────────────────────────────────────────
  // For each TP level, compute expected per-trade return against the BASELINE
  // cohort using a simple model:
  //   if token's peak >= tp: TP hit → (tp × (1 - gap_penalty) − cost)
  //   else:                  fall through to T+300 → ((1+pct_t300/100)/(1+pct_t30/100)-1)*100 − cost
  // This ignores the layered SL (keeping the panel focused on "where is TP optimal").
  // The user interprets it as: "TP X gives EV Y — the EV curve peaks at Z."
  const suggestedTp = TP_GRID.map((tp) => {
    if (nBaseline === 0) {
      return { tp_pct: tp, hit_rate_pct: 0, avg_nonhit_return_pct: 0, expected_return_pct: 0 };
    }
    let tpHits = 0;
    let nonhitReturnSum = 0;
    let nonhitCount = 0;
    for (const r of baseline) {
      if (r.max_relret_0_300 >= tp) {
        tpHits++;
      } else {
        const finalRet = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
        nonhitReturnSum += finalRet;
        nonhitCount++;
      }
    }
    const hitRate = tpHits / nBaseline;
    const avgNonhit = nonhitCount > 0 ? nonhitReturnSum / nonhitCount : 0;
    const expectedHit = tp * (1 - TP_GAP_PENALTY);
    const avgCost = baseline.reduce((s, r) => s + r.cost_pct, 0) / nBaseline;
    const ev = hitRate * expectedHit + (1 - hitRate) * avgNonhit - avgCost;
    return {
      tp_pct: tp,
      hit_rate_pct: +(hitRate * 100).toFixed(1),
      avg_nonhit_return_pct: +avgNonhit.toFixed(2),
      expected_return_pct: +ev.toFixed(2),
    };
  });
  const recommended = suggestedTp.length > 0
    ? suggestedTp.reduce((best, r) => r.expected_return_pct > best.expected_return_pct ? r : best)
    : null;

  return {
    generated_at: new Date().toISOString(),
    disclaimer:
      'max_relret_0_300 is look-ahead — known only at T+300, not at entry. These panels are DIAGNOSTIC ' +
      '(TP calibration, exit timing, filter quality scoring). Do NOT use peak > X% as a trading filter.',
    n_total: nTotal,
    n_baseline: nBaseline,
    cdf,
    peak_time_histogram: peakTimeHistogram,
    per_filter: perFilter,
    suggested_tp: suggestedTp,
    recommended_tp: recommended
      ? { tp_pct: recommended.tp_pct, expected_return_pct: recommended.expected_return_pct }
      : null,
  };
}
