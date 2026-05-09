import type Database from 'better-sqlite3';
import {
  listDailyReports,
  listLessons,
  type DailyReportRow,
  type ActionItem,
  type LessonRow,
} from '../db/queries';
import { runDiagnosis } from './diagnose';
import { computeEdgeDecay } from './edge-decay';

/**
 * Daily trading report — persistent cross-session memory for /report.
 *
 * The bot computes the numerical aggregates here every gist-sync cycle so the
 * page is always populated even when the routine /daily-report Claude run
 * hasn't fired yet. The narrative + structured recommendations are written by
 * Claude via report-upsert commands on strategy-commands.json (see
 * gist-sync.ts) and stored in the daily_reports DB table.
 *
 * Returns:
 *   - today_auto: numerical aggregates for the current UTC day (winners,
 *     losers, by-strategy stats, deltas vs yesterday, auto-detected
 *     anomalies, diagnose verdict). Always populated.
 *   - today_report: the Claude-authored row for today's date if it exists.
 *   - recent_reports: last 14 reports for cross-day pattern detection.
 *   - weekly_aggregates: last 4 ISO weeks of trade aggregates.
 *   - lessons: active long-term institutional-memory entries.
 *   - open_action_items: every PROPOSED action across recent reports — the
 *     loop-closer that lets tomorrow's Claude audit yesterday's plan.
 */

export interface TradeRow {
  id: number;
  graduation_id: number;
  mint: string;
  strategy_id: string | null;
  execution_mode: string | null;
  entry_timestamp: number | null;
  exit_timestamp: number | null;
  entry_price_sol: number | null;
  exit_price_sol: number | null;
  exit_reason: string | null;
  net_return_pct: number | null;
  gross_return_pct: number | null;
  net_profit_sol: number | null;
  held_seconds: number | null;
}

export interface PerStrategyToday {
  strategy_id: string;
  label: string;
  enabled: boolean;
  n: number;
  median_net_pct: number | null;
  mean_net_pct: number | null;
  win_rate_pct: number | null;
  net_profit_sol: number;
  exit_mix: { take_profit: number; stop_loss: number; timeout: number; other: number };
}

export interface DeltaVsYesterday {
  strategy_id: string;
  label: string;
  n_today: number;
  n_yesterday: number;
  median_today_pct: number | null;
  median_yesterday_pct: number | null;
  delta_median_pp: number | null;
  win_rate_today_pct: number | null;
  win_rate_yesterday_pct: number | null;
  delta_win_rate_pp: number | null;
}

export interface AutoAnomaly {
  severity: 'low' | 'med' | 'high';
  kind: string;
  detail: string;
  metric?: Record<string, number | string | null>;
}

export interface WeeklyBucket {
  iso_week: string; // 'YYYY-Www'
  start_date: string; // 'YYYY-MM-DD'
  end_date: string;
  n_trades: number;
  median_net_pct: number | null;
  mean_net_pct: number | null;
  win_rate_pct: number | null;
  net_profit_sol: number;
}

export interface DailyReportView {
  date: string;
  generated_at: number;
  generated_by: string | null;
  winners: unknown;
  losers: unknown;
  recommendations: unknown;
  anomalies: unknown;
  patterns: unknown;
  action_items: ActionItem[];
  narrative: string | null;
  updates: Array<{ at: number; note: string }>;
  // Summary metrics auto-derived for history-table rendering.
  summary: {
    n_trades: number;
    median_net_pct: number | null;
    win_rate_pct: number | null;
  };
}

export interface DailyReportData {
  generated_at: string;
  today_auto: {
    date: string;
    n_trades: number;
    n_trades_yesterday: number;
    n_graduations: number;
    diagnose_verdict: string;
    diagnose_next_action: string;
    today_net_profit_sol: number;
    winners: TradeRow[];
    losers: TradeRow[];
    by_strategy: PerStrategyToday[];
    delta_vs_yesterday: DeltaVsYesterday[];
    anomalies_auto: AutoAnomaly[];
  };
  today_report: DailyReportView | null;
  recent_reports: DailyReportView[];
  weekly_aggregates: WeeklyBucket[];
  lessons: LessonRow[];
  open_action_items: Array<ActionItem & { from_date: string }>;
  notes: string[];
}

// ── Date helpers (UTC) ──────────────────────────────────────────────────

/** Unix epoch seconds for the start of the UTC day containing `nowSec`. */
function utcDayStartSec(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

function utcDateString(nowSec: number): string {
  const d = new Date(nowSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoWeekString(date: Date): string {
  // ISO 8601: week 1 contains the first Thursday of the year.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ── Statistics helpers ─────────────────────────────────────────────────

function median(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const m = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1 ? sortedAsc[m] : (sortedAsc[m - 1] + sortedAsc[m]) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function winRatePct(values: number[]): number | null {
  if (values.length === 0) return null;
  const wins = values.filter(v => v > 0).length;
  return +((wins / values.length) * 100).toFixed(1);
}

function classifyExitReason(reason: string | null): keyof PerStrategyToday['exit_mix'] {
  if (!reason) return 'other';
  const r = reason.toLowerCase();
  if (r.includes('take_profit') || r === 'tp' || r.includes('profit')) return 'take_profit';
  if (r.includes('stop_loss') || r === 'sl' || r.includes('loss') || r.includes('killswitch')) return 'stop_loss';
  if (r.includes('timeout') || r.includes('max_hold') || r.includes('time')) return 'timeout';
  return 'other';
}

// ── Today's auto-stats ─────────────────────────────────────────────────

interface RawTradeRow {
  id: number;
  graduation_id: number;
  mint: string;
  strategy_id: string | null;
  execution_mode: string | null;
  entry_timestamp: number | null;
  exit_timestamp: number | null;
  entry_price_sol: number | null;
  exit_price_sol: number | null;
  exit_reason: string | null;
  net_return_pct: number | null;
  gross_return_pct: number | null;
  net_profit_sol: number | null;
}

function fetchTradesInWindow(
  db: Database.Database,
  startSec: number,
  endSec: number,
): RawTradeRow[] {
  return db.prepare(`
    SELECT id, graduation_id, mint, strategy_id, execution_mode,
           entry_timestamp, exit_timestamp, entry_price_sol, exit_price_sol,
           exit_reason, net_return_pct, gross_return_pct, net_profit_sol
    FROM trades_v2
    WHERE status = 'closed'
      AND exit_timestamp IS NOT NULL
      AND exit_timestamp >= ?
      AND exit_timestamp < ?
      AND (archived IS NULL OR archived = 0)
    ORDER BY exit_timestamp DESC
  `).all(startSec, endSec) as RawTradeRow[];
}

function toTradeRow(r: RawTradeRow): TradeRow {
  return {
    id: r.id,
    graduation_id: r.graduation_id,
    mint: r.mint,
    strategy_id: r.strategy_id,
    execution_mode: r.execution_mode,
    entry_timestamp: r.entry_timestamp,
    exit_timestamp: r.exit_timestamp,
    entry_price_sol: r.entry_price_sol,
    exit_price_sol: r.exit_price_sol,
    exit_reason: r.exit_reason,
    net_return_pct: r.net_return_pct,
    gross_return_pct: r.gross_return_pct,
    net_profit_sol: r.net_profit_sol,
    held_seconds: r.entry_timestamp != null && r.exit_timestamp != null
      ? r.exit_timestamp - r.entry_timestamp
      : null,
  };
}

function aggregateByStrategy(
  trades: RawTradeRow[],
  configs: Map<string, { label: string; enabled: boolean }>,
): PerStrategyToday[] {
  const byStrategy = new Map<string, RawTradeRow[]>();
  for (const t of trades) {
    if (!t.strategy_id) continue;
    const arr = byStrategy.get(t.strategy_id) ?? [];
    arr.push(t);
    byStrategy.set(t.strategy_id, arr);
  }

  const out: PerStrategyToday[] = [];
  for (const [strategyId, rows] of byStrategy) {
    const nets = rows.map(r => r.net_return_pct).filter((v): v is number => v != null);
    const sortedNets = [...nets].sort((a, b) => a - b);
    const config = configs.get(strategyId);
    const exitMix = { take_profit: 0, stop_loss: 0, timeout: 0, other: 0 };
    for (const r of rows) exitMix[classifyExitReason(r.exit_reason)] += 1;
    const profit = rows.reduce((s, r) => s + (r.net_profit_sol ?? 0), 0);

    out.push({
      strategy_id: strategyId,
      label: config?.label ?? strategyId,
      enabled: config?.enabled ?? false,
      n: rows.length,
      median_net_pct: median(sortedNets),
      mean_net_pct: mean(nets) != null ? +mean(nets)!.toFixed(2) : null,
      win_rate_pct: winRatePct(nets),
      net_profit_sol: +profit.toFixed(4),
      exit_mix: exitMix,
    });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

function buildDeltas(
  today: PerStrategyToday[],
  yesterday: PerStrategyToday[],
): DeltaVsYesterday[] {
  const yMap = new Map(yesterday.map(s => [s.strategy_id, s]));
  return today.map(t => {
    const y = yMap.get(t.strategy_id);
    const dMedian = t.median_net_pct != null && y?.median_net_pct != null
      ? +(t.median_net_pct - y.median_net_pct).toFixed(2)
      : null;
    const dWr = t.win_rate_pct != null && y?.win_rate_pct != null
      ? +(t.win_rate_pct - y.win_rate_pct).toFixed(1)
      : null;
    return {
      strategy_id: t.strategy_id,
      label: t.label,
      n_today: t.n,
      n_yesterday: y?.n ?? 0,
      median_today_pct: t.median_net_pct,
      median_yesterday_pct: y?.median_net_pct ?? null,
      delta_median_pp: dMedian,
      win_rate_today_pct: t.win_rate_pct,
      win_rate_yesterday_pct: y?.win_rate_pct ?? null,
      delta_win_rate_pp: dWr,
    };
  });
}

// ── Auto-anomaly detection ──────────────────────────────────────────────

function detectAnomalies(
  db: Database.Database,
  todayStartSec: number,
  yesterdayStartSec: number,
  diagnoseVerdict: string,
  byStrategyToday: PerStrategyToday[],
): AutoAnomaly[] {
  const anomalies: AutoAnomaly[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // ── 1. Diagnose not HEALTHY ──
  if (diagnoseVerdict !== 'HEALTHY' && diagnoseVerdict !== 'NO_DATA') {
    anomalies.push({
      severity: diagnoseVerdict.includes('FAIL') ? 'high' : 'med',
      kind: 'diagnose_unhealthy',
      detail: `/api/diagnose verdict is ${diagnoseVerdict}. See diagnose.json for the failing level.`,
      metric: { verdict: diagnoseVerdict },
    });
  }

  // ── 2. Graduation rate drop (today vs 7-day median) ──
  const sevenDaysAgo = todayStartSec - 7 * 86400;
  const todayGradCount = (db.prepare(
    'SELECT COUNT(*) as c FROM graduations WHERE timestamp >= ?'
  ).get(todayStartSec) as { c: number }).c;
  // Per-day grad counts for the last 7 full days.
  const dailyCounts: number[] = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = todayStartSec - (i + 1) * 86400;
    const dayEnd = todayStartSec - i * 86400;
    const c = (db.prepare(
      'SELECT COUNT(*) as c FROM graduations WHERE timestamp >= ? AND timestamp < ?'
    ).get(dayStart, dayEnd) as { c: number }).c;
    dailyCounts.push(c);
  }
  const sortedCounts = [...dailyCounts].sort((a, b) => a - b);
  const medianGradPerDay = median(sortedCounts);
  if (medianGradPerDay != null && medianGradPerDay > 0) {
    // Project today's count to a full day's pace based on elapsed UTC seconds.
    const elapsedSec = Math.max(1, nowSec - todayStartSec);
    const projected = (todayGradCount / elapsedSec) * 86400;
    if (projected < medianGradPerDay * 0.7) {
      anomalies.push({
        severity: 'high',
        kind: 'graduation_rate_drop',
        detail: `Projected grad count today (${projected.toFixed(0)}) is <70% of 7-day median (${medianGradPerDay.toFixed(0)}). Listener / RPC issue likely.`,
        metric: { projected: +projected.toFixed(0), median_7d: medianGradPerDay, today_so_far: todayGradCount },
      });
    }
  }

  // ── 3. Bot errors in last 24h ──
  const recentErrors = (db.prepare(
    'SELECT COUNT(*) as c FROM bot_errors WHERE ts >= ?'
  ).get(sevenDaysAgo + 6 * 86400) as { c: number }).c;
  if (recentErrors > 0) {
    anomalies.push({
      severity: recentErrors > 5 ? 'high' : 'med',
      kind: 'bot_errors',
      detail: `${recentErrors} uncaught exception(s) / unhandled rejection(s) in the last 24h. See bot_errors table.`,
      metric: { count_24h: recentErrors },
    });
  }

  // ── 4. Edge decay flags ──
  try {
    const edgeDecay = computeEdgeDecay(db);
    const decaying = edgeDecay.rows.filter(r => r.flag === 'DECAYING');
    for (const row of decaying) {
      anomalies.push({
        severity: 'med',
        kind: 'edge_decay',
        detail: `Strategy ${row.label} (${row.strategy_id}) flagged DECAYING — recent-30 median ${row.recent_30_median_pct ?? '?'}% vs all median ${row.all.median_net_pct ?? '?'}%.`,
        metric: {
          strategy_id: row.strategy_id,
          recent_30_median_pct: row.recent_30_median_pct,
          all_median_pct: row.all.median_net_pct,
        },
      });
    }
  } catch {
    /* edge-decay compute failure shouldn't block the report */
  }

  // ── 5. Strict-filter watchdog — enabled strategy with no closed trades in 6h ──
  // Demoted from strategy_stalled HIGH/MED to strict_filter LOW (2026-05-09):
  // skip-reason analysis showed every stalled strategy was being correctly
  // rejected by its own filters (top5<10%, vel bands, +5..+100 entry gate),
  // not starved by a pipeline issue. Triple-filter strategies have ~0.4% pass
  // rates and naturally take 20+ hours per hit at current graduation cadence.
  // We still surface the row so the operator can spot strategies that should
  // be retired or have their filters loosened, but it's no longer an alarm.
  const sixHoursAgo = nowSec - 6 * 3600;
  const staleStrategies = db.prepare(`
    SELECT c.id as strategy_id, c.label,
           MAX(t.exit_timestamp) as last_exit
    FROM strategy_configs c
    LEFT JOIN trades_v2 t ON t.strategy_id = c.id AND t.status = 'closed'
                          AND (t.archived IS NULL OR t.archived = 0)
    WHERE c.enabled = 1
    GROUP BY c.id, c.label
  `).all() as Array<{ strategy_id: string; label: string; last_exit: number | null }>;
  for (const s of staleStrategies) {
    if (s.last_exit == null) continue; // never traded — different problem, skip
    if (s.last_exit < sixHoursAgo) {
      const hoursAgo = Math.floor((nowSec - s.last_exit) / 3600);
      anomalies.push({
        severity: 'low',
        kind: 'strict_filter',
        detail: `"${s.label}" (${s.strategy_id}) — no trade in ${hoursAgo}h. Selective filters; pipeline confirmed feeding (see skip-reason panel).`,
        metric: { strategy_id: s.strategy_id, hours_since_last_trade: hoursAgo },
      });
    }
  }

  // ── 6. Exit-mix shift — TP/SL ratio today vs prior 7 days, per strategy ──
  // Skip if today's n is too small to be meaningful.
  const sevenDayStart = todayStartSec - 7 * 86400;
  for (const today of byStrategyToday) {
    if (today.n < 5) continue;
    const total = today.exit_mix.take_profit + today.exit_mix.stop_loss + today.exit_mix.timeout + today.exit_mix.other;
    if (total === 0) continue;
    const todayTpPct = (today.exit_mix.take_profit / total) * 100;
    const todaySlPct = (today.exit_mix.stop_loss / total) * 100;

    const baselineRow = db.prepare(`
      SELECT exit_reason, COUNT(*) as c
      FROM trades_v2
      WHERE strategy_id = ? AND status = 'closed' AND exit_timestamp IS NOT NULL
        AND exit_timestamp >= ? AND exit_timestamp < ?
        AND (archived IS NULL OR archived = 0)
      GROUP BY exit_reason
    `).all(today.strategy_id, sevenDayStart, todayStartSec) as Array<{ exit_reason: string | null; c: number }>;

    const baselineMix = { take_profit: 0, stop_loss: 0, timeout: 0, other: 0 };
    let baselineTotal = 0;
    for (const row of baselineRow) {
      baselineMix[classifyExitReason(row.exit_reason)] += row.c;
      baselineTotal += row.c;
    }
    if (baselineTotal < 10) continue; // not enough history

    const baseTpPct = (baselineMix.take_profit / baselineTotal) * 100;
    const baseSlPct = (baselineMix.stop_loss / baselineTotal) * 100;
    const tpDelta = todayTpPct - baseTpPct;
    const slDelta = todaySlPct - baseSlPct;
    if (Math.abs(tpDelta) > 15 || Math.abs(slDelta) > 15) {
      anomalies.push({
        severity: 'med',
        kind: 'exit_mix_shift',
        detail: `${today.label}: TP rate ${todayTpPct.toFixed(0)}% (Δ${tpDelta >= 0 ? '+' : ''}${tpDelta.toFixed(0)}pp) / SL ${todaySlPct.toFixed(0)}% (Δ${slDelta >= 0 ? '+' : ''}${slDelta.toFixed(0)}pp) vs 7-day baseline.`,
        metric: {
          strategy_id: today.strategy_id,
          today_tp_pct: +todayTpPct.toFixed(1),
          today_sl_pct: +todaySlPct.toFixed(1),
          baseline_tp_pct: +baseTpPct.toFixed(1),
          baseline_sl_pct: +baseSlPct.toFixed(1),
        },
      });
    }
  }

  // Sort high → med → low so most important surface first.
  const sevOrder: Record<AutoAnomaly['severity'], number> = { high: 0, med: 1, low: 2 };
  anomalies.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  return anomalies;
}

// ── Weekly aggregates ───────────────────────────────────────────────────

function computeWeeklyAggregates(db: Database.Database, weeks = 4): WeeklyBucket[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = new Date(nowSec * 1000);
  const buckets: WeeklyBucket[] = [];

  // Walk back `weeks` ISO weeks. Each bucket spans [Mon 00:00 UTC, next Mon).
  const dayUtcMidnight = (d: Date) =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  const todayDow = today.getUTCDay() || 7; // Mon=1..Sun=7
  const thisWeekStart = new Date(today);
  thisWeekStart.setUTCDate(today.getUTCDate() - (todayDow - 1));
  thisWeekStart.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < weeks; i++) {
    const weekStart = new Date(thisWeekStart);
    weekStart.setUTCDate(thisWeekStart.getUTCDate() - i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

    const startSec = dayUtcMidnight(weekStart);
    const endSec = dayUtcMidnight(weekEnd);

    const trades = fetchTradesInWindow(db, startSec, endSec);
    const nets = trades.map(t => t.net_return_pct).filter((v): v is number => v != null);
    const sortedNets = [...nets].sort((a, b) => a - b);
    const profit = trades.reduce((s, r) => s + (r.net_profit_sol ?? 0), 0);

    buckets.push({
      iso_week: isoWeekString(weekStart),
      start_date: utcDateString(startSec),
      end_date: utcDateString(endSec - 1),
      n_trades: trades.length,
      median_net_pct: median(sortedNets),
      mean_net_pct: mean(nets) != null ? +mean(nets)!.toFixed(2) : null,
      win_rate_pct: winRatePct(nets),
      net_profit_sol: +profit.toFixed(4),
    });
  }
  return buckets;
}

// ── Report row → view ───────────────────────────────────────────────────

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToView(row: DailyReportRow): DailyReportView {
  const winners = parseJson<TradeRow[]>(row.winners_json, []);
  const losers = parseJson<TradeRow[]>(row.losers_json, []);
  const allTrades = [...winners, ...losers];
  const nets = allTrades.map(t => t.net_return_pct).filter((v): v is number => v != null);
  const sortedNets = [...nets].sort((a, b) => a - b);

  return {
    date: row.date,
    generated_at: row.generated_at,
    generated_by: row.generated_by,
    winners: parseJson(row.winners_json, null),
    losers: parseJson(row.losers_json, null),
    recommendations: parseJson(row.recommendations_json, null),
    anomalies: parseJson(row.anomalies_json, null),
    patterns: parseJson(row.patterns_json, null),
    action_items: parseJson<ActionItem[]>(row.action_items_json, []),
    narrative: row.narrative,
    updates: parseJson<Array<{ at: number; note: string }>>(row.updates_json, []),
    summary: {
      n_trades: allTrades.length,
      median_net_pct: median(sortedNets),
      win_rate_pct: winRatePct(nets),
    },
  };
}

// ── Main compute ────────────────────────────────────────────────────────

export function computeDailyReport(db: Database.Database): DailyReportData {
  const generated_at = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStartSec = utcDayStartSec(nowSec);
  const yesterdayStartSec = todayStartSec - 86400;
  const todayDate = utcDateString(todayStartSec);

  // Today's trades + yesterday's trades for delta computation.
  const todayTrades = fetchTradesInWindow(db, todayStartSec, todayStartSec + 86400);
  const yesterdayTrades = fetchTradesInWindow(db, yesterdayStartSec, todayStartSec);

  // Strategy configs map.
  const configRows = db.prepare(
    'SELECT id, label, enabled FROM strategy_configs'
  ).all() as Array<{ id: string; label: string; enabled: number }>;
  const configMap = new Map(
    configRows.map(c => [c.id, { label: c.label, enabled: c.enabled === 1 }]),
  );

  // Per-strategy aggregates.
  const byStrategyToday = aggregateByStrategy(todayTrades, configMap);
  const byStrategyYesterday = aggregateByStrategy(yesterdayTrades, configMap);
  const deltas = buildDeltas(byStrategyToday, byStrategyYesterday);

  // Winners/losers — top/bottom 5 by net_return_pct.
  const sortedByReturn = [...todayTrades]
    .filter(t => t.net_return_pct != null)
    .sort((a, b) => (b.net_return_pct as number) - (a.net_return_pct as number));
  const winners = sortedByReturn.slice(0, 5).map(toTradeRow);
  const losers = sortedByReturn.slice(-5).reverse().map(toTradeRow);

  // Diagnose verdict (single call — same one runs every gist-sync, so
  // duplicate work is cheap).
  let diagnoseVerdict = 'NO_DATA';
  let diagnoseNextAction = 'Bot has no graduations yet.';
  try {
    const d = runDiagnosis(db);
    diagnoseVerdict = d.verdict;
    diagnoseNextAction = d.next_action;
  } catch {
    /* keep defaults */
  }

  // Auto-anomalies.
  const anomalies = detectAnomalies(
    db, todayStartSec, yesterdayStartSec, diagnoseVerdict, byStrategyToday,
  );

  // Today's net P&L.
  const todayProfit = todayTrades.reduce((s, t) => s + (t.net_profit_sol ?? 0), 0);

  // Today's graduation count.
  const todayGradCount = (db.prepare(
    'SELECT COUNT(*) as c FROM graduations WHERE timestamp >= ?'
  ).get(todayStartSec) as { c: number }).c;

  // Recent reports.
  const reportRows = listDailyReports(db, 60);
  const allViews = reportRows.map(rowToView);
  const todayReport = allViews.find(v => v.date === todayDate) ?? null;
  const recentReports = allViews.filter(v => v.date !== todayDate).slice(0, 14);

  // Weekly aggregates (last 4 ISO weeks, current first).
  const weeklyAggregates = computeWeeklyAggregates(db, 4);

  // Lessons-learned (active only).
  const lessons = listLessons(db, false);

  // Open action items across all recent reports.
  const openActionItems: Array<ActionItem & { from_date: string }> = [];
  for (const v of [todayReport, ...recentReports].filter((x): x is DailyReportView => x != null)) {
    for (const item of v.action_items) {
      if (item.status === 'PROPOSED') {
        openActionItems.push({ ...item, from_date: v.date });
      }
    }
  }
  openActionItems.sort((a, b) => b.proposed_at - a.proposed_at);

  return {
    generated_at,
    today_auto: {
      date: todayDate,
      n_trades: todayTrades.length,
      n_trades_yesterday: yesterdayTrades.length,
      n_graduations: todayGradCount,
      diagnose_verdict: diagnoseVerdict,
      diagnose_next_action: diagnoseNextAction,
      today_net_profit_sol: +todayProfit.toFixed(4),
      winners,
      losers,
      by_strategy: byStrategyToday,
      delta_vs_yesterday: deltas,
      anomalies_auto: anomalies,
    },
    today_report: todayReport,
    recent_reports: recentReports,
    weekly_aggregates: weeklyAggregates,
    lessons,
    open_action_items: openActionItems,
    notes: [
      'today_auto is recomputed every gist-sync cycle — fresh numbers even if no Claude run has fired.',
      'today_report is null until /daily-report runs and pushes a report-upsert via strategy-commands.json.',
      'Action items track "what was proposed yesterday and whether it was done" — flip status with action-item-update commands.',
      'Lessons-learned is institutional memory across many sessions; manage with lesson-upsert / lesson-archive commands.',
      'Anomalies are auto-detected by the bot; Claude can add additional ones in the report-upsert payload.',
    ],
  };
}
