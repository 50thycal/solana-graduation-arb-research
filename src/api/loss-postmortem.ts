import type Database from 'better-sqlite3';

/**
 * Loss postmortem clusterer. For each enabled strategy:
 *   1. Pull worst 20 closed trades by net_return_pct ASC.
 *   2. Pull the strategy's full closed-trade population.
 *   3. Join graduation_momentum on graduation_id to grab entry-time features.
 *   4. For each feature, bucket the strategy's population into 5 quintiles
 *      (boundaries computed from the strategy's own trades, not global).
 *   5. Compute per-bucket {loser_pct, overall_pct, deviation_pp}.
 *   6. Sort features by max |deviation_pp|; surface the top 3 with deviation
 *      >= 20pp as "dominant loss patterns."
 *
 * Bucket boundaries are computed over the strategy's own population so the
 * panel reflects what the strategy actually trades — a global quintile would
 * dilute the signal when a strategy only trades within a narrow slice of
 * the population.
 *
 * Features with all-null values for the strategy's trades are silently
 * skipped (e.g. sniper data on older trades that pre-date the sniper-window
 * collector). Only features with at least 5 non-null trades qualify.
 */

const FEATURE_COLUMNS = [
  'bc_velocity_sol_per_min',
  'holder_count',
  'top5_wallet_pct',
  'dev_wallet_pct',
  'liquidity_sol_t30',
  'monotonicity_0_30',
  'max_drawdown_0_30',
  'acceleration_t30',
  'sum_abs_returns_0_30',
  'buy_pressure_unique_buyers',
  'buy_pressure_buy_ratio',
  'buy_pressure_whale_pct',
  'sniper_count_t0_t2',
  'sniper_wallet_velocity_avg',
  'creator_prior_token_count',
  'creator_prior_rug_rate',
] as const;

type FeatureName = typeof FEATURE_COLUMNS[number];

const WORST_TRADE_COUNT = 20;
const BUCKETS = 5;
const DEVIATION_THRESHOLD_PP = 20;
const MIN_NONNULL_FOR_FEATURE = 5;

interface LoserRow {
  trade_id: number;
  graduation_id: number;
  mint: string;
  net_return_pct: number;
  gross_return_pct: number | null;
  exit_reason: string;
  held_seconds: number | null;
  features: Partial<Record<FeatureName, number | null>>;
}

interface BucketDeviation {
  /** Bucket index (0 = lowest values, 4 = highest). */
  bucket: number;
  /** Quintile range as `[lo, hi]` inclusive of lo, exclusive of hi (top bucket inclusive of hi). */
  range: [number, number];
  loser_count: number;
  loser_pct: number;
  overall_count: number;
  overall_pct: number;
  /** loser_pct - overall_pct in pp. Positive means losers cluster in this bucket. */
  deviation_pp: number;
}

interface FeatureSummary {
  feature: FeatureName;
  /** Buckets[bucket].deviation_pp with the largest |value|. */
  max_abs_deviation_pp: number;
  /** Bucket where the max deviation occurred. */
  worst_bucket: number;
  /** All 5 buckets, ordered low -> high. */
  buckets: BucketDeviation[];
  loser_n: number;
  overall_n: number;
}

export interface LossPostmortemRow {
  strategy_id: string;
  label: string;
  execution_mode: string;
  /** Total closed-trade count (the population baseline). */
  population_n: number;
  /** Number of losers used (capped at WORST_TRADE_COUNT, may be less if fewer losing trades exist). */
  loser_n: number;
  /** Top 3 features with |deviation_pp| >= DEVIATION_THRESHOLD_PP, sorted by |deviation_pp| desc. */
  dominant_patterns: FeatureSummary[];
  /** All evaluated features so the operator can see medium-strength signals too. */
  all_features: FeatureSummary[];
  /** Raw loser rows for the drill-down table. */
  losers: Array<{
    trade_id: number;
    graduation_id: number;
    mint: string;
    net_return_pct: number;
    gross_return_pct: number | null;
    exit_reason: string;
    held_seconds: number | null;
    features: Record<string, number | null>;
  }>;
}

export interface LossPostmortemData {
  generated_at: string;
  strategy_count: number;
  rows: LossPostmortemRow[];
  notes: string[];
}

/** Linear-interpolated percentile (NIST). */
function pctile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** Compute quintile boundaries [b1, b2, b3, b4] (4 cut points produce 5 buckets). */
function quintileBoundaries(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map(p => pctile(sorted, p));
}

/** Bucket index for a value given quintile boundaries. */
function bucketFor(value: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value < boundaries[i]) return i;
  }
  return boundaries.length;
}

interface PopulationRow {
  trade_id: number;
  net_return_pct: number;
  features: Partial<Record<FeatureName, number | null>>;
}

function computeFeatureSummary(
  feature: FeatureName,
  losers: LoserRow[],
  population: PopulationRow[],
): FeatureSummary | null {
  const popValues: number[] = [];
  for (const r of population) {
    const v = r.features[feature];
    if (v != null && Number.isFinite(v)) popValues.push(v);
  }
  if (popValues.length < MIN_NONNULL_FOR_FEATURE) return null;

  const loserValues: number[] = [];
  for (const r of losers) {
    const v = r.features[feature];
    if (v != null && Number.isFinite(v)) loserValues.push(v);
  }
  if (loserValues.length === 0) return null;

  const boundaries = quintileBoundaries(popValues);

  // Build sorted population so we can describe each bucket's value range.
  const sortedPop = [...popValues].sort((a, b) => a - b);
  const popMin = sortedPop[0];
  const popMax = sortedPop[sortedPop.length - 1];
  const bucketRanges: Array<[number, number]> = [
    [popMin, boundaries[0]],
    [boundaries[0], boundaries[1]],
    [boundaries[1], boundaries[2]],
    [boundaries[2], boundaries[3]],
    [boundaries[3], popMax],
  ].map(([lo, hi]) => [+lo.toFixed(4), +hi.toFixed(4)] as [number, number]);

  const popCounts = new Array<number>(BUCKETS).fill(0);
  for (const v of popValues) popCounts[bucketFor(v, boundaries)]++;
  const loserCounts = new Array<number>(BUCKETS).fill(0);
  for (const v of loserValues) loserCounts[bucketFor(v, boundaries)]++;

  const buckets: BucketDeviation[] = [];
  let maxAbs = 0;
  let worstBucket = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const overallPct = +((popCounts[b] / popValues.length) * 100).toFixed(1);
    const loserPct = +((loserCounts[b] / loserValues.length) * 100).toFixed(1);
    const dev = +(loserPct - overallPct).toFixed(1);
    if (Math.abs(dev) > maxAbs) { maxAbs = Math.abs(dev); worstBucket = b; }
    buckets.push({
      bucket: b,
      range: bucketRanges[b],
      loser_count: loserCounts[b],
      loser_pct: loserPct,
      overall_count: popCounts[b],
      overall_pct: overallPct,
      deviation_pp: dev,
    });
  }

  return {
    feature,
    max_abs_deviation_pp: maxAbs,
    worst_bucket: worstBucket,
    buckets,
    loser_n: loserValues.length,
    overall_n: popValues.length,
  };
}

export function computeLossPostmortem(db: Database.Database): LossPostmortemData {
  const generated_at = new Date().toISOString();

  const enabled = db.prepare(`
    SELECT id, label FROM strategy_configs WHERE enabled = 1
  `).all() as Array<{ id: string; label: string }>;

  if (enabled.length === 0) {
    return {
      generated_at,
      strategy_count: 0,
      rows: [],
      notes: ['No active strategies — toggle one on to populate this panel.'],
    };
  }

  const featureSelect = FEATURE_COLUMNS.map(f => `gm.${f}`).join(', ');

  const rows: LossPostmortemRow[] = [];
  for (const strat of enabled) {
    const populationRows = db.prepare(`
      SELECT
        t.id AS trade_id,
        t.net_return_pct,
        ${featureSelect}
      FROM trades_v2 t
      LEFT JOIN graduation_momentum gm ON gm.graduation_id = t.graduation_id
      WHERE t.strategy_id = ?
        AND t.status = 'closed'
        AND (t.archived IS NULL OR t.archived = 0)
        AND t.net_return_pct IS NOT NULL
        AND t.graduation_id IS NOT NULL
    `).all(strat.id) as Array<Record<string, number | null>>;

    const population: PopulationRow[] = populationRows.map(r => {
      const features: Partial<Record<FeatureName, number | null>> = {};
      for (const f of FEATURE_COLUMNS) features[f] = r[f] ?? null;
      return {
        trade_id: r.trade_id as number,
        net_return_pct: r.net_return_pct as number,
        features,
      };
    });

    if (population.length === 0) {
      rows.push({
        strategy_id: strat.id,
        label: strat.label,
        execution_mode: 'paper',
        population_n: 0,
        loser_n: 0,
        dominant_patterns: [],
        all_features: [],
        losers: [],
      });
      continue;
    }

    const sortedByNet = [...population].sort((a, b) => a.net_return_pct - b.net_return_pct);
    const loserSlice = sortedByNet.slice(0, WORST_TRADE_COUNT);

    const loserDetailRows = db.prepare(`
      SELECT
        t.id AS trade_id,
        t.graduation_id,
        t.mint,
        t.net_return_pct,
        t.gross_return_pct,
        COALESCE(t.exit_reason, '') AS exit_reason,
        COALESCE(t.execution_mode, 'paper') AS execution_mode,
        CASE WHEN t.exit_timestamp IS NOT NULL AND t.entry_timestamp IS NOT NULL
             THEN t.exit_timestamp - t.entry_timestamp END AS held_seconds,
        ${featureSelect}
      FROM trades_v2 t
      LEFT JOIN graduation_momentum gm ON gm.graduation_id = t.graduation_id
      WHERE t.id IN (${loserSlice.map(() => '?').join(',')})
    `).all(...loserSlice.map(l => l.trade_id)) as Array<Record<string, number | string | null>>;

    // Re-sort loser detail rows in the same worst-first order as loserSlice.
    const detailById = new Map<number, Record<string, number | string | null>>();
    for (const d of loserDetailRows) detailById.set(d.trade_id as number, d);

    const losers: LoserRow[] = loserSlice.map(l => {
      const d = detailById.get(l.trade_id);
      const features: Partial<Record<FeatureName, number | null>> = {};
      for (const f of FEATURE_COLUMNS) features[f] = (d?.[f] as number | null) ?? null;
      return {
        trade_id: l.trade_id,
        graduation_id: (d?.graduation_id as number) ?? 0,
        mint: (d?.mint as string) ?? '',
        net_return_pct: l.net_return_pct,
        gross_return_pct: (d?.gross_return_pct as number | null) ?? null,
        exit_reason: (d?.exit_reason as string) ?? '',
        held_seconds: (d?.held_seconds as number | null) ?? null,
        features,
      };
    });

    const executionMode = (loserDetailRows[0]?.execution_mode as string) ?? 'paper';

    const featureSummaries: FeatureSummary[] = [];
    for (const f of FEATURE_COLUMNS) {
      const summary = computeFeatureSummary(f, losers, population);
      if (summary) featureSummaries.push(summary);
    }

    featureSummaries.sort((a, b) => b.max_abs_deviation_pp - a.max_abs_deviation_pp);
    const dominant = featureSummaries
      .filter(f => f.max_abs_deviation_pp >= DEVIATION_THRESHOLD_PP)
      .slice(0, 3);

    rows.push({
      strategy_id: strat.id,
      label: strat.label,
      execution_mode: executionMode,
      population_n: population.length,
      loser_n: losers.length,
      dominant_patterns: dominant,
      all_features: featureSummaries,
      losers: losers.map(l => ({
        trade_id: l.trade_id,
        graduation_id: l.graduation_id,
        mint: l.mint,
        net_return_pct: l.net_return_pct,
        gross_return_pct: l.gross_return_pct,
        exit_reason: l.exit_reason,
        held_seconds: l.held_seconds,
        features: l.features as Record<string, number | null>,
      })),
    });
  }

  // Sort: strategies with the strongest dominant pattern first.
  rows.sort((a, b) => {
    const aMax = a.dominant_patterns[0]?.max_abs_deviation_pp ?? 0;
    const bMax = b.dominant_patterns[0]?.max_abs_deviation_pp ?? 0;
    return bMax - aMax;
  });

  return {
    generated_at,
    strategy_count: enabled.length,
    rows,
    notes: [
      `Worst ${WORST_TRADE_COUNT} closed trades per strategy by net_return_pct. Population baseline = strategy's full closed-trade history.`,
      `Bucket boundaries computed from each strategy's own population (5 quintiles), so the panel reflects what the strategy actually trades.`,
      `dominant_patterns surface features with max |deviation_pp| >= ${DEVIATION_THRESHOLD_PP}pp; all_features lists every feature with at least ${MIN_NONNULL_FOR_FEATURE} non-null values.`,
      'deviation_pp = loser_pct - overall_pct in a bucket. Positive = losers cluster there; negative = losers avoid it.',
      'Features with too many nulls (e.g. sniper data on pre-2026 trades) are silently skipped.',
    ],
  };
}
