import type Database from 'better-sqlite3';

/**
 * External market regime panel. Joins closed trades to `market_daily` on
 * date(entry_timestamp, 'unixepoch') = market_daily.date and bucket-aggregates
 * per-strategy P&L by:
 *   - SOL/USD daily return quintile
 *   - BTC/USD daily return quintile
 *   - Fear & Greed regime (5 native buckets: Extreme Fear → Extreme Greed)
 *
 * Quintile cutoffs are computed in JS over the distinct days that have
 * market data (SQLite stock has no NTILE). When the distinct-day count is
 * below MIN_DAYS_FOR_QUINTILES, falls back to terciles and flags
 * `low_sample: true` on each output.
 *
 * Trades whose entry date has no market_daily row (fetch lag, weekend gaps in
 * F&G) bucket as "unknown" with a flag — they're still included in per-
 * strategy totals so n stays auditable.
 *
 * No look-ahead: market regime is pinned to the UTC date of `entry_timestamp`,
 * never exit. F&G is published mid-UTC-day; using day-of-entry is correct
 * because the trade decision was made under that day's regime even if the
 * value was finalized later.
 */

const MIN_DAYS_FOR_QUINTILES = 25;
const MIN_TRADES_PER_STRATEGY = 30;

export type RegimeBucketKind = 'sol_return' | 'btc_return' | 'fear_greed';

export interface RegimeBucketStats {
  n: number;
  total_net_sol: number;
  avg_net_pct: number | null;
  win_rate: number | null;
  drop_top3_net_sol: number;
}

export interface QuintileBucketRow extends RegimeBucketStats {
  /** 1-based bucket index. 1 = lowest quintile, 5 = highest. (or 1-3 in fallback) */
  bucket: number;
  /** Inclusive cutoffs as % return for SOL/BTC. */
  range_label: string;
}

export interface FngBucketRow extends RegimeBucketStats {
  label: string;        // 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
  value_range: string;  // e.g. '0-25'
}

export interface UnknownBucketRow extends RegimeBucketStats {
  reason: 'no_market_row';
}

export interface StrategyMarketRow {
  strategy_id: string;
  label: string;
  n_total: number;
  sol_return: {
    cutoffs_pct: number[];           // length 4 for quintiles, length 2 for terciles
    buckets: QuintileBucketRow[];
    low_sample: boolean;
    unknown: UnknownBucketRow | null;
  };
  btc_return: {
    cutoffs_pct: number[];
    buckets: QuintileBucketRow[];
    low_sample: boolean;
    unknown: UnknownBucketRow | null;
  };
  fear_greed: {
    buckets: FngBucketRow[];
    unknown: UnknownBucketRow | null;
  };
}

export interface TrendsMarketData {
  generated_at: string;
  market_data_present: boolean;
  market_days: number;
  date_range: { earliest: string | null; latest: string | null };
  bucketing_mode: 'quintiles' | 'terciles' | 'none';
  fng_distribution: Array<{ label: string; n: number }>;
  by_strategy: StrategyMarketRow[];
  notes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface MarketRow {
  date: string;
  sol_usd_open: number | null;
  sol_usd_close: number | null;
  btc_usd_open: number | null;
  btc_usd_close: number | null;
  fear_greed_value: number | null;
  fear_greed_label: string | null;
}

interface TradeRow {
  strategy_id: string;
  entry_date: string;
  net_profit_sol: number;
  net_return_pct: number;
}

const FNG_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: 'Extreme Fear', min: 0, max: 24 },
  { label: 'Fear', min: 25, max: 44 },
  { label: 'Neutral', min: 45, max: 54 },
  { label: 'Greed', min: 55, max: 74 },
  { label: 'Extreme Greed', min: 75, max: 100 },
];

function fngLabelFromValue(v: number | null): string | null {
  if (v == null) return null;
  const hit = FNG_BUCKETS.find(b => v >= b.min && v <= b.max);
  return hit?.label ?? null;
}

function summarize(trades: TradeRow[]): RegimeBucketStats {
  const n = trades.length;
  if (n === 0) {
    return { n: 0, total_net_sol: 0, avg_net_pct: null, win_rate: null, drop_top3_net_sol: 0 };
  }
  const total = trades.reduce((s, t) => s + t.net_profit_sol, 0);
  const avg = trades.reduce((s, t) => s + t.net_return_pct, 0) / n;
  const wins = trades.filter(t => t.net_return_pct > 0).length;
  const sorted = trades.map(t => t.net_profit_sol).sort((a, b) => b - a);
  const drop = sorted.slice(Math.min(3, sorted.length)).reduce((s, v) => s + v, 0);
  return {
    n,
    total_net_sol: +total.toFixed(6),
    avg_net_pct: +avg.toFixed(2),
    win_rate: +((wins / n) * 100).toFixed(2),
    drop_top3_net_sol: +drop.toFixed(6),
  };
}

/** Compute bucket cutoffs from a sorted-ascending series. nBuckets values out
 *  produce (nBuckets - 1) cutoffs. */
function cutoffs(sortedAsc: number[], nBuckets: number): number[] {
  if (sortedAsc.length === 0 || nBuckets < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < nBuckets; i++) {
    const idx = (sortedAsc.length - 1) * (i / nBuckets);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const v = lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
    out.push(v);
  }
  return out;
}

/** Return 1-based bucket index for `value` given `cutoffs`. nBuckets = cutoffs.length+1. */
function bucketOf(value: number, sortedCutoffs: number[]): number {
  let i = 0;
  while (i < sortedCutoffs.length && value > sortedCutoffs[i]) i++;
  return i + 1;
}

function rangeLabelForBucket(bucket: number, cutoffs: number[]): string {
  const lo = bucket === 1 ? null : cutoffs[bucket - 2];
  const hi = bucket > cutoffs.length ? null : cutoffs[bucket - 1];
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
  if (lo == null && hi != null) return `<= ${fmt(hi)}`;
  if (hi == null && lo != null) return `> ${fmt(lo)}`;
  if (lo != null && hi != null) return `${fmt(lo)} → ${fmt(hi)}`;
  return '—';
}

// ── Main compute ──────────────────────────────────────────────────────────

export function computeTrendsMarket(db: Database.Database): TrendsMarketData {
  const generated_at = new Date().toISOString();

  const marketRows = db.prepare(`
    SELECT date, sol_usd_open, sol_usd_close, btc_usd_open, btc_usd_close,
           fear_greed_value, fear_greed_label
    FROM market_daily
    ORDER BY date ASC
  `).all() as MarketRow[];

  if (marketRows.length === 0) {
    return {
      generated_at,
      market_data_present: false,
      market_days: 0,
      date_range: { earliest: null, latest: null },
      bucketing_mode: 'none',
      fng_distribution: [],
      by_strategy: [],
      notes: [
        'No market_daily rows yet — MarketDataFetcher has not populated the table.',
        'Check GITHUB_TOKEN env (lifecycle hook in src/index.ts) and outbound network to api.coingecko.com.',
      ],
    };
  }

  // Per-day SOL return % and BTC return % (close - open) / open. Drop days
  // with missing OHLC.
  const solReturnsByDate = new Map<string, number>();
  const btcReturnsByDate = new Map<string, number>();
  const fngByDate = new Map<string, { value: number; label: string }>();
  for (const r of marketRows) {
    if (r.sol_usd_open != null && r.sol_usd_close != null && r.sol_usd_open > 0) {
      solReturnsByDate.set(r.date, (r.sol_usd_close - r.sol_usd_open) / r.sol_usd_open);
    }
    if (r.btc_usd_open != null && r.btc_usd_close != null && r.btc_usd_open > 0) {
      btcReturnsByDate.set(r.date, (r.btc_usd_close - r.btc_usd_open) / r.btc_usd_open);
    }
    if (r.fear_greed_value != null) {
      const label = r.fear_greed_label ?? fngLabelFromValue(r.fear_greed_value) ?? 'Neutral';
      fngByDate.set(r.date, { value: r.fear_greed_value, label });
    }
  }

  const nDistinctDays = Math.max(solReturnsByDate.size, btcReturnsByDate.size);
  const bucketingMode: 'quintiles' | 'terciles' | 'none' =
    nDistinctDays >= MIN_DAYS_FOR_QUINTILES ? 'quintiles' :
    nDistinctDays >= 6 ? 'terciles' : 'none';
  const nBuckets = bucketingMode === 'quintiles' ? 5 : bucketingMode === 'terciles' ? 3 : 0;

  const solCutoffs = nBuckets > 0
    ? cutoffs(Array.from(solReturnsByDate.values()).sort((a, b) => a - b), nBuckets)
    : [];
  const btcCutoffs = nBuckets > 0
    ? cutoffs(Array.from(btcReturnsByDate.values()).sort((a, b) => a - b), nBuckets)
    : [];

  const fngDistribution = FNG_BUCKETS.map(b => ({
    label: b.label,
    n: Array.from(fngByDate.values()).filter(v => v.label === b.label).length,
  }));

  // ── Per-strategy trades (gated by MIN_TRADES_PER_STRATEGY) ──
  const eligibleStrategies = db.prepare(`
    SELECT strategy_id, COUNT(*) AS n
    FROM trades_v2
    WHERE status = 'closed'
      AND entry_timestamp IS NOT NULL
      AND net_profit_sol IS NOT NULL
      AND net_return_pct IS NOT NULL
    GROUP BY strategy_id
    HAVING n >= ?
  `).all(MIN_TRADES_PER_STRATEGY) as Array<{ strategy_id: string; n: number }>;

  if (eligibleStrategies.length === 0) {
    return {
      generated_at,
      market_data_present: true,
      market_days: marketRows.length,
      date_range: { earliest: marketRows[0].date, latest: marketRows[marketRows.length - 1].date },
      bucketing_mode: bucketingMode,
      fng_distribution: fngDistribution,
      by_strategy: [],
      notes: [`No strategies with >= ${MIN_TRADES_PER_STRATEGY} closed trades — nothing to bucket.`],
    };
  }

  const strategyIds = eligibleStrategies.map(r => r.strategy_id);
  const placeholders = strategyIds.map(() => '?').join(',');
  const labelMap = new Map<string, string>(
    (db.prepare(`SELECT id, label FROM strategy_configs`).all() as Array<{ id: string; label: string }>)
      .map(r => [r.id, r.label]),
  );

  const tradeRows = db.prepare(`
    SELECT
      strategy_id,
      strftime('%Y-%m-%d', entry_timestamp, 'unixepoch') AS entry_date,
      net_profit_sol,
      net_return_pct
    FROM trades_v2
    WHERE status = 'closed'
      AND entry_timestamp IS NOT NULL
      AND net_profit_sol IS NOT NULL
      AND net_return_pct IS NOT NULL
      AND strategy_id IN (${placeholders})
  `).all(...strategyIds) as TradeRow[];

  const tradesByStrategy = new Map<string, TradeRow[]>();
  for (const t of tradeRows) {
    if (!tradesByStrategy.has(t.strategy_id)) tradesByStrategy.set(t.strategy_id, []);
    tradesByStrategy.get(t.strategy_id)!.push(t);
  }

  const lowSample = bucketingMode !== 'quintiles';

  const byStrategy: StrategyMarketRow[] = [];
  for (const sid of strategyIds) {
    const trades = tradesByStrategy.get(sid) ?? [];

    const bucketTradesByKey = <K>(
      key: (t: TradeRow) => K | null,
    ): { bucketed: Map<K, TradeRow[]>; unknown: TradeRow[] } => {
      const bucketed = new Map<K, TradeRow[]>();
      const unknown: TradeRow[] = [];
      for (const t of trades) {
        const k = key(t);
        if (k == null) { unknown.push(t); continue; }
        if (!bucketed.has(k)) bucketed.set(k, []);
        bucketed.get(k)!.push(t);
      }
      return { bucketed, unknown };
    };

    // SOL return quintile/tercile bucket
    const solRes = bucketTradesByKey(t => {
      const r = solReturnsByDate.get(t.entry_date);
      if (r == null || nBuckets === 0) return null;
      return bucketOf(r, solCutoffs);
    });
    const solBuckets: QuintileBucketRow[] = [];
    for (let b = 1; b <= nBuckets; b++) {
      const slice = solRes.bucketed.get(b) ?? [];
      solBuckets.push({
        bucket: b,
        range_label: rangeLabelForBucket(b, solCutoffs),
        ...summarize(slice),
      });
    }

    const btcRes = bucketTradesByKey(t => {
      const r = btcReturnsByDate.get(t.entry_date);
      if (r == null || nBuckets === 0) return null;
      return bucketOf(r, btcCutoffs);
    });
    const btcBuckets: QuintileBucketRow[] = [];
    for (let b = 1; b <= nBuckets; b++) {
      const slice = btcRes.bucketed.get(b) ?? [];
      btcBuckets.push({
        bucket: b,
        range_label: rangeLabelForBucket(b, btcCutoffs),
        ...summarize(slice),
      });
    }

    const fngRes = bucketTradesByKey(t => fngByDate.get(t.entry_date)?.label ?? null);
    const fngBuckets: FngBucketRow[] = FNG_BUCKETS.map(b => ({
      label: b.label,
      value_range: `${b.min}-${b.max}`,
      ...summarize(fngRes.bucketed.get(b.label) ?? []),
    }));

    byStrategy.push({
      strategy_id: sid,
      label: labelMap.get(sid) ?? sid,
      n_total: trades.length,
      sol_return: {
        cutoffs_pct: solCutoffs.map(c => +(c * 100).toFixed(3)),
        buckets: solBuckets,
        low_sample: lowSample,
        unknown: solRes.unknown.length > 0
          ? { reason: 'no_market_row', ...summarize(solRes.unknown) }
          : null,
      },
      btc_return: {
        cutoffs_pct: btcCutoffs.map(c => +(c * 100).toFixed(3)),
        buckets: btcBuckets,
        low_sample: lowSample,
        unknown: btcRes.unknown.length > 0
          ? { reason: 'no_market_row', ...summarize(btcRes.unknown) }
          : null,
      },
      fear_greed: {
        buckets: fngBuckets,
        unknown: fngRes.unknown.length > 0
          ? { reason: 'no_market_row', ...summarize(fngRes.unknown) }
          : null,
      },
    });
  }

  // Sort by absolute spread (top quintile - bottom quintile) on SOL return —
  // surfaces the most market-regime-sensitive strategies first.
  byStrategy.sort((a, b) => {
    const aTop = a.sol_return.buckets.at(-1)?.total_net_sol ?? 0;
    const aBot = a.sol_return.buckets[0]?.total_net_sol ?? 0;
    const bTop = b.sol_return.buckets.at(-1)?.total_net_sol ?? 0;
    const bBot = b.sol_return.buckets[0]?.total_net_sol ?? 0;
    return Math.abs(bTop - bBot) - Math.abs(aTop - aBot);
  });

  return {
    generated_at,
    market_data_present: true,
    market_days: marketRows.length,
    date_range: { earliest: marketRows[0].date, latest: marketRows[marketRows.length - 1].date },
    bucketing_mode: bucketingMode,
    fng_distribution: fngDistribution,
    by_strategy: byStrategy,
    notes: [
      `Per-strategy gate: >= ${MIN_TRADES_PER_STRATEGY} closed trades.`,
      `Bucketing: ${bucketingMode} (need >= ${MIN_DAYS_FOR_QUINTILES} distinct market-data days for quintiles).`,
      'SOL/BTC returns: (close - open) / open per UTC date. Quintile cutoffs computed across all market_daily rows that have OHLC.',
      'Fear & Greed: native 5-bucket labels (Extreme Fear / Fear / Neutral / Greed / Extreme Greed), pinned to UTC entry date.',
      'unknown bucket: trades whose entry UTC date had no market_daily row (fetch lag, gaps). Counted but not bucketed.',
      'Per-strategy sort: by |top quintile total_net_sol - bottom quintile total_net_sol| — most regime-sensitive first.',
    ],
  };
}
