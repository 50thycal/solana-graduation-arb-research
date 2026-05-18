import type Database from 'better-sqlite3';
import { dailyNetSolByStrategy, type DailyNetSolPoint } from './trends-time';

/**
 * Cross-strategy / portfolio panel. For each pair of currently-enabled
 * strategies with sufficient overlap:
 *   - Pearson correlation on date-aligned daily net-SOL series
 *   - Top 5 redundancy pairs (highest |r|) and diversifiers (lowest |r|)
 *   - Combined-portfolio equity curve: sum of all enabled strategies'
 *     daily net SOL, cumulative. Reports max drawdown, annualized Sharpe,
 *     terminal equity.
 *   - Concentration: per day, max(strategy_net) / sum(|strategy_net|);
 *     median + p90 across days.
 *
 * Sharpe is daily mean / daily std * sqrt(365). Requires >=10 overlapping
 * days per pair for Pearson, >=2 active days for Sharpe.
 *
 * "Enabled" = strategy_configs.enabled = 1. Matches the convention in
 * edge-decay / strategy-percentiles.
 */

const MIN_OVERLAP_DAYS = 10;
const MIN_TRADES_PER_STRATEGY = 30;

export interface PairRow {
  strategy_a: string;
  strategy_b: string;
  overlap_days: number;
  pearson: number | null;
}

export interface EquityPoint {
  date: string;
  daily_net_sol: number;
  cum_net_sol: number;
  drawdown_sol: number;            // negative = below running peak; 0 = at peak
}

export interface ConcentrationDay {
  date: string;
  max_share_pct: number;            // top-1 strategy's share of |total|
  active_strategies: number;
}

export interface PortfolioCorrData {
  generated_at: string;
  strategy_count: number;
  matrix: {
    strategies: string[];           // axis ordering for the N×N matrix
    rows: Array<Array<number | null>>;
  };
  redundancy_top: PairRow[];        // top 5 |r|
  diversifier_top: PairRow[];       // bottom 5 |r|
  combined: {
    days: number;
    terminal_sol: number;
    daily_mean_sol: number | null;
    daily_std_sol: number | null;
    sharpe_annualized: number | null;
    max_drawdown_sol: number;
    max_drawdown_pct: number | null; // % of running peak; null if running peak <= 0
    equity_curve: EquityPoint[];
  };
  concentration: {
    median_max_share_pct: number | null;
    p90_max_share_pct: number | null;
    daily: ConcentrationDay[];
  };
  notes: string[];
}

interface EnabledStrategy {
  id: string;
  label: string;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (denom < 1e-12) return null;
  return (n * sxy - sx * sy) / denom;
}

function percentile(sortedAsc: number[], pct: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * pct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function computePortfolioCorr(db: Database.Database): PortfolioCorrData {
  const generated_at = new Date().toISOString();

  const enabled = db.prepare(`
    SELECT id, label FROM strategy_configs WHERE enabled = 1
  `).all() as EnabledStrategy[];

  if (enabled.length === 0) {
    return {
      generated_at,
      strategy_count: 0,
      matrix: { strategies: [], rows: [] },
      redundancy_top: [], diversifier_top: [],
      combined: {
        days: 0, terminal_sol: 0,
        daily_mean_sol: null, daily_std_sol: null, sharpe_annualized: null,
        max_drawdown_sol: 0, max_drawdown_pct: null, equity_curve: [],
      },
      concentration: { median_max_share_pct: null, p90_max_share_pct: null, daily: [] },
      notes: ['No enabled strategies — toggle one on to populate.'],
    };
  }

  // Pull each enabled strategy's daily net-SOL series, filter to those with
  // >= MIN_TRADES_PER_STRATEGY total trades (skip thin strategies — Pearson on
  // 5 days is noise).
  const seriesByStrategy = new Map<string, DailyNetSolPoint[]>();
  const labelMap = new Map<string, string>();
  for (const s of enabled) {
    const series = dailyNetSolByStrategy(db, s.id);
    const totalN = series.reduce((sum, p) => sum + p.n, 0);
    if (totalN < MIN_TRADES_PER_STRATEGY) continue;
    seriesByStrategy.set(s.id, series);
    labelMap.set(s.id, s.label);
  }

  const ids = Array.from(seriesByStrategy.keys());
  if (ids.length === 0) {
    return {
      generated_at,
      strategy_count: enabled.length,
      matrix: { strategies: [], rows: [] },
      redundancy_top: [], diversifier_top: [],
      combined: {
        days: 0, terminal_sol: 0,
        daily_mean_sol: null, daily_std_sol: null, sharpe_annualized: null,
        max_drawdown_sol: 0, max_drawdown_pct: null, equity_curve: [],
      },
      concentration: { median_max_share_pct: null, p90_max_share_pct: null, daily: [] },
      notes: [`Enabled strategies exist but none have >= ${MIN_TRADES_PER_STRATEGY} closed trades yet.`],
    };
  }

  // ── Pairwise Pearson ──
  const pairs: PairRow[] = [];
  const matrix: Array<Array<number | null>> = Array.from({ length: ids.length },
    () => new Array(ids.length).fill(null));
  for (let i = 0; i < ids.length; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < ids.length; j++) {
      const a = seriesByStrategy.get(ids[i])!;
      const b = seriesByStrategy.get(ids[j])!;
      const bMap = new Map(b.map(p => [p.date, p.net_sol]));
      const aligned: Array<[number, number]> = [];
      for (const p of a) {
        const bv = bMap.get(p.date);
        if (bv != null) aligned.push([p.net_sol, bv]);
      }
      if (aligned.length < MIN_OVERLAP_DAYS) {
        pairs.push({ strategy_a: ids[i], strategy_b: ids[j], overlap_days: aligned.length, pearson: null });
        continue;
      }
      const r = pearson(aligned.map(p => p[0]), aligned.map(p => p[1]));
      const rounded = r == null ? null : +r.toFixed(4);
      matrix[i][j] = rounded;
      matrix[j][i] = rounded;
      pairs.push({
        strategy_a: ids[i], strategy_b: ids[j],
        overlap_days: aligned.length, pearson: rounded,
      });
    }
  }

  const scored = pairs.filter(p => p.pearson != null);
  const byAbs = [...scored].sort((a, b) => Math.abs(b.pearson!) - Math.abs(a.pearson!));
  const redundancy_top = byAbs.slice(0, 5);
  const diversifier_top = [...scored].sort((a, b) => Math.abs(a.pearson!) - Math.abs(b.pearson!)).slice(0, 5);

  // ── Combined portfolio equity ──
  const dateUnion = new Set<string>();
  for (const series of seriesByStrategy.values()) {
    for (const p of series) dateUnion.add(p.date);
  }
  const dates = Array.from(dateUnion).sort();

  // Per-day totals + per-day per-strategy nets for concentration.
  const dailyTotals: Array<{ date: string; net: number; perStrategy: Map<string, number> }> = [];
  for (const d of dates) {
    let total = 0;
    const perS = new Map<string, number>();
    for (const [sid, series] of seriesByStrategy) {
      const pt = series.find(p => p.date === d);
      if (pt) { total += pt.net_sol; perS.set(sid, pt.net_sol); }
    }
    dailyTotals.push({ date: d, net: total, perStrategy: perS });
  }

  const equityCurve: EquityPoint[] = [];
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  let maxDDpct: number | null = null;
  for (const d of dailyTotals) {
    cum += d.net;
    if (cum > peak) peak = cum;
    const dd = cum - peak;            // <= 0
    if (dd < maxDD) {
      maxDD = dd;
      if (peak > 0) maxDDpct = (dd / peak) * 100;
    }
    equityCurve.push({
      date: d.date,
      daily_net_sol: +d.net.toFixed(6),
      cum_net_sol: +cum.toFixed(6),
      drawdown_sol: +dd.toFixed(6),
    });
  }

  const dailyNets = dailyTotals.map(d => d.net);
  const dailyMean = mean(dailyNets);
  const dailyStd = stddev(dailyNets);
  const sharpe = (dailyMean != null && dailyStd != null && dailyStd > 1e-9)
    ? (dailyMean / dailyStd) * Math.sqrt(365)
    : null;

  // ── Concentration: per day, top-1 strategy's share of total |net| ──
  const concentrationDaily: ConcentrationDay[] = [];
  for (const d of dailyTotals) {
    const vals = Array.from(d.perStrategy.values());
    const absSum = vals.reduce((s, v) => s + Math.abs(v), 0);
    if (absSum < 1e-9 || vals.length === 0) continue;
    const topAbs = Math.max(...vals.map(v => Math.abs(v)));
    concentrationDaily.push({
      date: d.date,
      max_share_pct: +((topAbs / absSum) * 100).toFixed(2),
      active_strategies: vals.length,
    });
  }
  const shares = concentrationDaily.map(c => c.max_share_pct).sort((a, b) => a - b);
  const medShare = percentile(shares, 0.5);
  const p90Share = percentile(shares, 0.9);

  return {
    generated_at,
    strategy_count: ids.length,
    matrix: { strategies: ids, rows: matrix },
    redundancy_top, diversifier_top,
    combined: {
      days: equityCurve.length,
      terminal_sol: +cum.toFixed(6),
      daily_mean_sol: dailyMean == null ? null : +dailyMean.toFixed(6),
      daily_std_sol: dailyStd == null ? null : +dailyStd.toFixed(6),
      sharpe_annualized: sharpe == null ? null : +sharpe.toFixed(3),
      max_drawdown_sol: +maxDD.toFixed(6),
      max_drawdown_pct: maxDDpct == null ? null : +maxDDpct.toFixed(2),
      equity_curve: equityCurve,
    },
    concentration: {
      median_max_share_pct: medShare == null ? null : +medShare.toFixed(2),
      p90_max_share_pct: p90Share == null ? null : +p90Share.toFixed(2),
      daily: concentrationDaily,
    },
    notes: [
      `Includes enabled strategies (strategy_configs.enabled=1) with >= ${MIN_TRADES_PER_STRATEGY} closed trades.`,
      `Pairwise Pearson requires >= ${MIN_OVERLAP_DAYS} overlapping days. Pairs below the threshold have pearson=null.`,
      'Sharpe = daily_mean / daily_std * sqrt(365). Null if std degenerate or <2 active days.',
      'Max drawdown is in SOL absolute (negative); _pct is vs running peak (null if peak never positive).',
      'Concentration: per-day, top-1 strategy share of sum(|net SOL|). Median + p90 across days.',
    ],
  };
}
