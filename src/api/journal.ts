import type Database from 'better-sqlite3';
import {
  listJournalEntries,
  type JournalPrediction,
  type JournalUpdate,
  type StrategyJournalRow,
} from '../db/queries';

/**
 * Strategy journal — per-cohort hypothesis log with append-only updates and
 * an auto-status badge derived from live closed-trade performance.
 *
 * Entries persist across strategy delete/disable by design. The `strategy_state`
 * field on each row tells you whether the underlying strategy is currently
 * enabled / disabled / deleted, so a year-old v9 entry is still readable
 * even after v9 was retired.
 *
 * The auto-status badge is independent of the manually-set `status` column
 * and is computed every render against the strategy's current closed-trade
 * stats. Manual statuses (PROMOTED / KILLED / PAUSED) override the auto badge.
 */

export type StrategyState = 'enabled' | 'disabled' | 'deleted';

/**
 * Auto-status badge categories. Computed against live trades:
 *   OPEN          — manual status=OPEN, n < target_n (still collecting data)
 *   ON-TRACK      — median net ≥ 70% of target_median_net_pct (allow some
 *                   slop while sample is still small)
 *   DEGRADING     — median net < target_median_net_pct − 5pp (live data is
 *                   substantially worse than predicted)
 *   HIT-KILL      — kill_criterion satisfied (parsed below)
 *   NO-DATA       — strategy has no closed trades yet
 *   PROMOTED / KILLED / PAUSED — manual status overrides; auto-status mirrors
 */
export type AutoStatus =
  | 'OPEN'
  | 'ON-TRACK'
  | 'DEGRADING'
  | 'HIT-KILL'
  | 'NO-DATA'
  | 'PROMOTED'
  | 'KILLED'
  | 'PAUSED';

export interface JournalEntryView {
  id: string;
  strategy_id: string;
  /** Whether the strategy_id resolves to an enabled/disabled/deleted strategy. */
  strategy_state: StrategyState;
  /** Live label from strategy_configs when available, else the strategy_id. */
  strategy_label: string;
  cohort_label: string | null;
  hypothesis: string;
  prediction: JournalPrediction | null;
  /** Manually-set status — operator's last word. */
  manual_status: string;
  /** Computed live status — independent of manual_status unless manual is a terminal verdict. */
  auto_status: AutoStatus;
  created_at: number;
  updated_at: number;
  updates: JournalUpdate[];
  /** Snapshot of the live closed-trade stats used to compute auto_status. */
  live_stats: {
    n_closed: number;
    median_net_pct: number | null;
    mean_net_pct: number | null;
    win_rate_pct: number | null;
  };
}

export interface JournalData {
  generated_at: string;
  entry_count: number;
  rows: JournalEntryView[];
  notes: string[];
}

interface PerStrategyStats {
  n_closed: number;
  median: number | null;
  mean: number | null;
  win_rate: number | null;
}

function median(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const m = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1
    ? sortedAsc[m]
    : (sortedAsc[m - 1] + sortedAsc[m]) / 2;
}

function buildPerStrategyStats(db: Database.Database): Map<string, PerStrategyStats> {
  const rows = db.prepare(`
    SELECT strategy_id, net_return_pct
    FROM trades_v2
    WHERE status = 'closed'
      AND (archived IS NULL OR archived = 0)
      AND net_return_pct IS NOT NULL
  `).all() as Array<{ strategy_id: string; net_return_pct: number }>;

  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (!buckets.has(r.strategy_id)) buckets.set(r.strategy_id, []);
    buckets.get(r.strategy_id)!.push(r.net_return_pct);
  }

  const out = new Map<string, PerStrategyStats>();
  for (const [strategyId, vals] of buckets) {
    const sorted = [...vals].sort((a, b) => a - b);
    const sum = vals.reduce((s, v) => s + v, 0);
    const mean = +(sum / vals.length).toFixed(2);
    const med = median(sorted);
    const wins = vals.filter(v => v > 0).length;
    out.set(strategyId, {
      n_closed: vals.length,
      median: med != null ? +med.toFixed(2) : null,
      mean,
      win_rate: +((wins / vals.length) * 100).toFixed(1),
    });
  }
  return out;
}

/**
 * Lightweight kill-criterion evaluator. Recognized forms (case-insensitive):
 *   "n>=N and median<X"   → trips when n_closed >= N AND median_net < X
 *   "median<X"            → trips when median_net < X (any n)
 *   "win_rate<X"          → trips when win_rate_pct < X (any n)
 * Unrecognized forms never trip; the operator falls back to manual KILLED.
 */
function killCriterionTripped(
  criterion: string | undefined | null,
  stats: PerStrategyStats,
): boolean {
  if (!criterion) return false;
  const c = criterion.toLowerCase().replace(/\s+/g, '');

  // "n>=N and median<X"
  const nAndMed = c.match(/n>=(\d+)and median<(-?\d+(?:\.\d+)?)/) ?? c.match(/n>=(\d+)andmedian<(-?\d+(?:\.\d+)?)/);
  if (nAndMed) {
    const n = parseInt(nAndMed[1], 10);
    const x = parseFloat(nAndMed[2]);
    return stats.n_closed >= n && stats.median != null && stats.median < x;
  }

  const medOnly = c.match(/^median<(-?\d+(?:\.\d+)?)$/);
  if (medOnly) {
    const x = parseFloat(medOnly[1]);
    return stats.median != null && stats.median < x;
  }

  const wrOnly = c.match(/^win_rate<(-?\d+(?:\.\d+)?)$/);
  if (wrOnly) {
    const x = parseFloat(wrOnly[1]);
    return stats.win_rate != null && stats.win_rate < x;
  }

  return false;
}

function computeAutoStatus(
  manualStatus: string,
  prediction: JournalPrediction | null,
  stats: PerStrategyStats,
): AutoStatus {
  // Terminal manual verdicts override the auto badge.
  if (manualStatus === 'PROMOTED') return 'PROMOTED';
  if (manualStatus === 'KILLED') return 'KILLED';
  if (manualStatus === 'PAUSED') return 'PAUSED';

  if (stats.n_closed === 0) return 'NO-DATA';

  if (killCriterionTripped(prediction?.kill_criterion, stats)) return 'HIT-KILL';

  const targetMedian = prediction?.target_median_net_pct;
  const targetN = prediction?.target_n;

  // No quantitative prediction: stay OPEN until a manual verdict is set.
  if (targetMedian == null) return 'OPEN';

  const liveMedian = stats.median;
  if (liveMedian == null) return 'OPEN';

  if (liveMedian < targetMedian - 5) return 'DEGRADING';
  if (liveMedian >= targetMedian * 0.7) return 'ON-TRACK';
  // Median is between the degrading floor and the on-track threshold — still
  // gathering data unless target_n is reached, at which point we treat it as
  // degrading because the prediction has resolved unfavorably.
  if (targetN != null && stats.n_closed >= targetN) return 'DEGRADING';
  return 'OPEN';
}

function parsePrediction(json: string | null): JournalPrediction | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as JournalPrediction;
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

function parseUpdates(json: string): JournalUpdate[] {
  try {
    const v = JSON.parse(json) as JournalUpdate[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function computeJournal(db: Database.Database): JournalData {
  const generated_at = new Date().toISOString();
  const entries = listJournalEntries(db);

  // Map every strategy_id referenced in journal to its current state.
  const configs = db.prepare(`
    SELECT id, label, enabled FROM strategy_configs
  `).all() as Array<{ id: string; label: string; enabled: number }>;
  const stateById = new Map<string, { state: StrategyState; label: string }>();
  for (const c of configs) {
    stateById.set(c.id, {
      state: c.enabled === 1 ? 'enabled' : 'disabled',
      label: c.label,
    });
  }

  const statsById = buildPerStrategyStats(db);

  const rows: JournalEntryView[] = entries.map((e: StrategyJournalRow) => {
    const stateInfo = stateById.get(e.strategy_id);
    const strategyState: StrategyState = stateInfo?.state ?? 'deleted';
    const strategyLabel = stateInfo?.label ?? e.strategy_id;

    const prediction = parsePrediction(e.prediction_json);
    const stats = statsById.get(e.strategy_id) ?? {
      n_closed: 0, median: null, mean: null, win_rate: null,
    };
    const autoStatus = computeAutoStatus(e.status, prediction, stats);

    return {
      id: e.id,
      strategy_id: e.strategy_id,
      strategy_state: strategyState,
      strategy_label: strategyLabel,
      cohort_label: e.cohort_label,
      hypothesis: e.hypothesis,
      prediction,
      manual_status: e.status,
      auto_status: autoStatus,
      created_at: e.created_at,
      updated_at: e.updated_at,
      updates: parseUpdates(e.updates_json),
      live_stats: {
        n_closed: stats.n_closed,
        median_net_pct: stats.median,
        mean_net_pct: stats.mean,
        win_rate_pct: stats.win_rate,
      },
    };
  });

  return {
    generated_at,
    entry_count: rows.length,
    rows,
    notes: [
      'Entries persist across strategy delete/disable by design — strategy_state flags whether the underlying strategy is currently enabled/disabled/deleted.',
      'auto_status is computed every render against live closed-trade stats; manual_status (PROMOTED/KILLED/PAUSED) is operator-set and overrides auto.',
      'kill_criterion supports: "n>=N and median<X", "median<X", "win_rate<X". Unparsed criteria never trip the HIT-KILL badge.',
      'Push journal-upsert / journal-update / journal-delete commands via strategy-commands.json on main; the bot ingests on the next sync cycle (~2 min).',
    ],
  };
}
