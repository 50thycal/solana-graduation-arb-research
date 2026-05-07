import type Database from 'better-sqlite3';

/**
 * Edge-decay tracker. For each enabled strategy, slices closed trades into
 * trade-count windows (last 25 / 50 / 100 / all) and reports mean + median
 * net return per window — so alpha decay shows up as a falling tail before
 * we commit live capital. Includes a 12-bin sparkline of rolling median
 * across the strategy's full closed-trade history.
 *
 * Flag rule:
 *   DECAYING       — median(last 30) < median(all) − 5pp
 *   STRENGTHENING  — median(last 30) > median(all) + 5pp
 *   STABLE         — within ±5pp of lifetime median
 *   LOW-N          — fewer than 25 closed trades total
 *
 * Cap of 200 trades per strategy keeps the SQL bounded — the windows we care
 * about (last 25/50/100) all fit, and "all-time" beyond 200 isn't useful for
 * decay detection (we want recent vs historical, not full archaeology).
 */

export type DecayFlag = 'DECAYING' | 'STRENGTHENING' | 'STABLE' | 'LOW-N';

export interface WindowStats {
  n: number;
  mean_net_pct: number | null;
  median_net_pct: number | null;
  win_rate_pct: number | null;
  avg_cost_pp: number | null;
}

export interface EdgeDecayRow {
  strategy_id: string;
  label: string;
  execution_mode: string;
  n_total: number;
  /** Last 25 trades by exit_timestamp desc. Null when n_total < 1. */
  last_25: WindowStats;
  last_50: WindowStats;
  last_100: WindowStats;
  /** All trades within the 200-row cap. */
  all: WindowStats;
  /** 12 equal-count bins across full history; each value is the bin's median net %. Bin order is oldest -> newest. Null entries when fewer than 12 distinct bins available. */
  sparkline: Array<number | null>;
  flag: DecayFlag;
  /** Median across the most recent ~30 trades (the window the flag rule uses). */
  recent_30_median_pct: number | null;
}

export interface EdgeDecayData {
  generated_at: string;
  strategy_count: number;
  rows: EdgeDecayRow[];
  notes: string[];
}

interface TradeRow {
  strategy_id: string;
  execution_mode: string;
  net_return_pct: number;
  gross_return_pct: number | null;
  exit_timestamp: number;
}

const TRADE_CAP_PER_STRATEGY = 200;
const SPARKLINE_BINS = 12;
const RECENT_WINDOW = 30;
const FLAG_THRESHOLD_PP = 5;

function median(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const m = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1
    ? sortedAsc[m]
    : (sortedAsc[m - 1] + sortedAsc[m]) / 2;
}

function summarize(slice: TradeRow[]): WindowStats {
  if (slice.length === 0) {
    return { n: 0, mean_net_pct: null, median_net_pct: null, win_rate_pct: null, avg_cost_pp: null };
  }
  const nets = slice.map(t => t.net_return_pct);
  const sortedNets = [...nets].sort((a, b) => a - b);
  const meanNet = nets.reduce((s, v) => s + v, 0) / nets.length;
  const med = median(sortedNets);
  const wins = nets.filter(v => v > 0).length;

  // avg_cost_pp = mean(gross) - mean(net). Captures slippage/fee drag in pp.
  // Skip rows where gross is null (can happen if a trade closed before gross
  // was computed — shouldn't normally exist but guard anyway).
  const grossPairs = slice.filter(t => t.gross_return_pct != null);
  let avgCost: number | null = null;
  if (grossPairs.length > 0) {
    const meanGross = grossPairs.reduce((s, t) => s + (t.gross_return_pct as number), 0) / grossPairs.length;
    const meanNetForCost = grossPairs.reduce((s, t) => s + t.net_return_pct, 0) / grossPairs.length;
    avgCost = +(meanGross - meanNetForCost).toFixed(2);
  }

  return {
    n: slice.length,
    mean_net_pct: +meanNet.toFixed(2),
    median_net_pct: med != null ? +med.toFixed(2) : null,
    win_rate_pct: +((wins / nets.length) * 100).toFixed(1),
    avg_cost_pp: avgCost,
  };
}

/** Bin trades (newest -> oldest from SQL) into equal-count buckets oldest -> newest, each carrying its median net. */
function buildSparkline(tradesNewestFirst: TradeRow[], bins: number): Array<number | null> {
  const out: Array<number | null> = new Array(bins).fill(null);
  if (tradesNewestFirst.length === 0) return out;

  // Reverse so oldest is first — sparkline reads left-to-right oldest -> newest.
  const oldestFirst = [...tradesNewestFirst].reverse();
  const total = oldestFirst.length;

  // If we have fewer trades than bins, leave trailing bins null and fill the
  // first `total` bins with single-trade values.
  const effectiveBins = Math.min(bins, total);
  const binSize = total / effectiveBins;

  for (let i = 0; i < effectiveBins; i++) {
    const start = Math.floor(i * binSize);
    const end = Math.floor((i + 1) * binSize);
    const slice = oldestFirst.slice(start, end);
    if (slice.length === 0) { out[i] = null; continue; }
    const sorted = slice.map(t => t.net_return_pct).sort((a, b) => a - b);
    const med = median(sorted);
    out[i] = med != null ? +med.toFixed(2) : null;
  }
  return out;
}

function classifyFlag(allMedian: number | null, recentMedian: number | null, n: number): DecayFlag {
  if (n < 25) return 'LOW-N';
  if (allMedian == null || recentMedian == null) return 'STABLE';
  const delta = recentMedian - allMedian;
  if (delta < -FLAG_THRESHOLD_PP) return 'DECAYING';
  if (delta > FLAG_THRESHOLD_PP) return 'STRENGTHENING';
  return 'STABLE';
}

export function computeEdgeDecay(db: Database.Database): EdgeDecayData {
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

  const placeholders = enabled.map(() => '?').join(',');
  const tradeRows = db.prepare(`
    SELECT
      strategy_id,
      COALESCE(execution_mode, 'paper') AS execution_mode,
      net_return_pct,
      gross_return_pct,
      exit_timestamp
    FROM trades_v2
    WHERE status = 'closed'
      AND (archived IS NULL OR archived = 0)
      AND net_return_pct IS NOT NULL
      AND exit_timestamp IS NOT NULL
      AND strategy_id IN (${placeholders})
    ORDER BY exit_timestamp DESC
  `).all(...enabled.map(s => s.id)) as TradeRow[];

  // Bucket per (strategy_id, execution_mode) — same key as strategy-percentiles
  // so the rows line up with the distribution panel.
  const buckets = new Map<string, TradeRow[]>();
  for (const t of tradeRows) {
    const key = `${t.strategy_id}|${t.execution_mode}`;
    if (!buckets.has(key)) buckets.set(key, []);
    const arr = buckets.get(key)!;
    if (arr.length < TRADE_CAP_PER_STRATEGY) arr.push(t);
  }

  const labelById = new Map(enabled.map(s => [s.id, s.label]));

  const rows: EdgeDecayRow[] = [];
  for (const [key, group] of buckets) {
    const [strategyId, executionMode] = key.split('|');
    const last25 = summarize(group.slice(0, 25));
    const last50 = summarize(group.slice(0, 50));
    const last100 = summarize(group.slice(0, 100));
    const all = summarize(group);

    const sparkline = buildSparkline(group, SPARKLINE_BINS);

    // Recent-window median for the flag rule. Uses up to RECENT_WINDOW trades
    // — distinct from last_25/50 because the flag's threshold (±5pp) was
    // calibrated against a 30-trade window per the plan.
    const recentSlice = group.slice(0, RECENT_WINDOW).map(t => t.net_return_pct).sort((a, b) => a - b);
    const recentMed = median(recentSlice);
    const flag = classifyFlag(all.median_net_pct, recentMed, all.n);

    rows.push({
      strategy_id: strategyId,
      label: labelById.get(strategyId) ?? strategyId,
      execution_mode: executionMode,
      n_total: all.n,
      last_25: last25,
      last_50: last50,
      last_100: last100,
      all,
      sparkline,
      flag,
      recent_30_median_pct: recentMed != null ? +recentMed.toFixed(2) : null,
    });
  }

  // Sort: DECAYING flags first (need attention), then by lifetime median desc.
  const flagOrder: Record<DecayFlag, number> = {
    'DECAYING': 0,
    'STABLE': 1,
    'STRENGTHENING': 2,
    'LOW-N': 3,
  };
  rows.sort((a, b) => {
    const fo = flagOrder[a.flag] - flagOrder[b.flag];
    if (fo !== 0) return fo;
    return (b.all.median_net_pct ?? -Infinity) - (a.all.median_net_pct ?? -Infinity);
  });

  return {
    generated_at,
    strategy_count: enabled.length,
    rows,
    notes: [
      'Trade-count windows: last 25 / 50 / 100 / all (capped at 200 per strategy).',
      `Flag fires DECAYING when median(last ${RECENT_WINDOW}) < median(all) - ${FLAG_THRESHOLD_PP}pp; STRENGTHENING for the inverse; STABLE otherwise. LOW-N when n_total < 25.`,
      'Sparkline: 12 equal-count bins across full history (oldest -> newest), each bin\'s value is its median net %. Null entries when fewer than 12 distinct bins available.',
      'avg_cost_pp = mean(gross) - mean(net) within the window — captures slippage/jito/fee drag in pp.',
      'Sorted: DECAYING first (need attention), then by lifetime median desc.',
    ],
  };
}
