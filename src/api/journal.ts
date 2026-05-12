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
 * Auto-status badge categories. Computed against live trades.
 *
 * When the prediction provides a SOL-denominated target (target_net_sol or
 * target_sol_per_mo), the evaluator uses that as the primary signal — this
 * matches the Promotion Readiness scorecard's SOL bar (n≥100 · drop_top3>0 ·
 * total≥0.5 SOL · monthly≥3.75 SOL). Falls back to target_median_net_pct for
 * legacy entries.
 *
 *   OPEN          — manual status=OPEN, n < target_n (still collecting data)
 *   ON-TRACK      — live metric ≥ 70% of target (slop allowance while small)
 *   DEGRADING     — live metric < target − slop (substantially worse than
 *                   predicted) OR target_n reached without hitting on-track
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
    /** Total net SOL across closed trades. 2026-05-12. */
    net_sol: number | null;
    /** Monthly run rate (SOL/mo) projected from observed window. NULL when window <1 day. */
    sol_per_mo: number | null;
    /** Net SOL after dropping the top 3 winning trades (robustness check). */
    drop_top3: number | null;
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
  /** Total net SOL across closed trades (sum of net_profit_sol). 2026-05-12. */
  net_sol: number | null;
  /** Monthly run rate of net SOL: net_sol * (30d / observed days). NULL when observed window <1 day. 2026-05-12. */
  sol_per_mo: number | null;
  /** Net SOL after leave-one-out removal of the top 3 winning trades.
   *  Robustness check: drop_top3 > 0 means edge survives the best 3 trades. 2026-05-12. */
  drop_top3: number | null;
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
    SELECT strategy_id, net_return_pct, net_profit_sol, entry_timestamp, exit_timestamp
    FROM trades_v2
    WHERE status = 'closed'
      AND (archived IS NULL OR archived = 0)
      AND net_return_pct IS NOT NULL
  `).all() as Array<{
    strategy_id: string;
    net_return_pct: number;
    net_profit_sol: number | null;
    entry_timestamp: number | null;
    exit_timestamp: number | null;
  }>;

  interface Bucket {
    rets: number[];
    sols: number[];
    minTs: number | null;
    maxTs: number | null;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (!buckets.has(r.strategy_id)) {
      buckets.set(r.strategy_id, { rets: [], sols: [], minTs: null, maxTs: null });
    }
    const b = buckets.get(r.strategy_id)!;
    b.rets.push(r.net_return_pct);
    if (r.net_profit_sol != null) b.sols.push(r.net_profit_sol);
    // Use entry_timestamp for the start, exit_timestamp for the end — gives a
    // real observation window for the monthly run-rate calculation.
    const start = r.entry_timestamp;
    const end = r.exit_timestamp ?? r.entry_timestamp;
    if (start != null) b.minTs = b.minTs == null ? start : Math.min(b.minTs, start);
    if (end != null) b.maxTs = b.maxTs == null ? end : Math.max(b.maxTs, end);
  }

  const out = new Map<string, PerStrategyStats>();
  for (const [strategyId, b] of buckets) {
    const sorted = [...b.rets].sort((a, b) => a - b);
    const sum = b.rets.reduce((s, v) => s + v, 0);
    const mean = +(sum / b.rets.length).toFixed(2);
    const med = median(sorted);
    const wins = b.rets.filter(v => v > 0).length;

    // SOL-denominated metrics. Mirrors the Promotion Readiness scorecard
    // (Report tab on the dashboard): total net SOL, monthly run rate,
    // leave-one-out top-3 drop.
    let netSol: number | null = null;
    let solPerMo: number | null = null;
    let dropTop3: number | null = null;
    if (b.sols.length > 0) {
      netSol = +b.sols.reduce((s, v) => s + v, 0).toFixed(4);
      // Monthly run rate: scale total SOL by 30 days / observed window. Only
      // computed when the observed window is at least 1 day (otherwise the
      // extrapolation is too noisy to be useful).
      if (b.minTs != null && b.maxTs != null) {
        const spanSec = Math.max(0, b.maxTs - b.minTs);
        const spanDays = spanSec / 86400;
        if (spanDays >= 1) {
          solPerMo = +(netSol * (30 / spanDays)).toFixed(3);
        }
      }
      // drop_top3: remove the three highest-SOL trades and resum. Cheap and
      // surfaces strategies whose edge collapses without the best 3 winners.
      if (b.sols.length >= 4) {
        const sortedDesc = [...b.sols].sort((a, b) => b - a);
        const trimmed = sortedDesc.slice(3);
        dropTop3 = +trimmed.reduce((s, v) => s + v, 0).toFixed(4);
      }
    }

    out.set(strategyId, {
      n_closed: b.rets.length,
      median: med != null ? +med.toFixed(2) : null,
      mean,
      win_rate: +((wins / b.rets.length) * 100).toFixed(1),
      net_sol: netSol,
      sol_per_mo: solPerMo,
      drop_top3: dropTop3,
    });
  }
  return out;
}

/**
 * Lightweight kill-criterion evaluator. Recognized forms (case-insensitive):
 *   "n>=N and net_sol<X"     → trips when n_closed >= N AND net_sol < X
 *   "net_sol<X"              → trips when net_sol < X (any n)
 *   "n>=N and sol_per_mo<X"  → trips when n_closed >= N AND sol_per_mo < X
 *   "sol_per_mo<X"           → trips when sol_per_mo < X (any n)
 *   "n>=N and drop_top3<X"   → trips when n_closed >= N AND drop_top3 < X
 *   "n>=N and median<X"      → trips when n_closed >= N AND median < X (legacy)
 *   "median<X"               → trips when median < X (legacy, any n)
 *   "win_rate<X"             → trips when win_rate_pct < X (any n)
 * Unrecognized forms never trip; the operator falls back to manual KILLED.
 *
 * 2026-05-12: SOL-denominated forms added. Prefer net_sol / sol_per_mo for
 * new journal entries — they match the Promotion Readiness scorecard bar
 * (n≥100 · drop_top3>0 · total≥0.5 SOL · monthly≥3.75 SOL). Median forms
 * kept for backwards-compat with legacy entries.
 */
function killCriterionTripped(
  criterion: string | undefined | null,
  stats: PerStrategyStats,
): boolean {
  if (!criterion) return false;
  const c = criterion.toLowerCase().replace(/\s+/g, '');

  // ── SOL-denominated forms (preferred) ───────────────────────────────────

  // "n>=N and net_sol<X"
  const nAndNetSol = c.match(/n>=(\d+)andnet_sol<(-?\d+(?:\.\d+)?)/);
  if (nAndNetSol) {
    const n = parseInt(nAndNetSol[1], 10);
    const x = parseFloat(nAndNetSol[2]);
    return stats.n_closed >= n && stats.net_sol != null && stats.net_sol < x;
  }
  const netSolOnly = c.match(/^net_sol<(-?\d+(?:\.\d+)?)$/);
  if (netSolOnly) {
    const x = parseFloat(netSolOnly[1]);
    return stats.net_sol != null && stats.net_sol < x;
  }

  // "n>=N and sol_per_mo<X"
  const nAndSolMo = c.match(/n>=(\d+)andsol_per_mo<(-?\d+(?:\.\d+)?)/);
  if (nAndSolMo) {
    const n = parseInt(nAndSolMo[1], 10);
    const x = parseFloat(nAndSolMo[2]);
    return stats.n_closed >= n && stats.sol_per_mo != null && stats.sol_per_mo < x;
  }
  const solMoOnly = c.match(/^sol_per_mo<(-?\d+(?:\.\d+)?)$/);
  if (solMoOnly) {
    const x = parseFloat(solMoOnly[1]);
    return stats.sol_per_mo != null && stats.sol_per_mo < x;
  }

  // "n>=N and drop_top3<X"
  const nAndDrop3 = c.match(/n>=(\d+)anddrop_top3<(-?\d+(?:\.\d+)?)/);
  if (nAndDrop3) {
    const n = parseInt(nAndDrop3[1], 10);
    const x = parseFloat(nAndDrop3[2]);
    return stats.n_closed >= n && stats.drop_top3 != null && stats.drop_top3 < x;
  }

  // ── Legacy median / win_rate forms (kept for backwards-compat) ──────────

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

  const targetN = prediction?.target_n;

  // Prefer SOL-denominated targets when provided (matches the Promotion
  // Readiness scorecard bar). Falls back to target_median_net_pct for
  // legacy entries that haven't been migrated.
  const targetNetSol = prediction?.target_net_sol;
  const targetSolMo = prediction?.target_sol_per_mo;
  const targetMedian = prediction?.target_median_net_pct;

  // No quantitative prediction at all: stay OPEN until a manual verdict.
  if (targetNetSol == null && targetSolMo == null && targetMedian == null) {
    return 'OPEN';
  }

  // SOL-bar evaluation: if either net_sol or sol_per_mo target is set, use it.
  // ON-TRACK requires hitting ≥70% of the easier of the two metrics; DEGRADING
  // when live metric falls below the threshold by a meaningful margin.
  if (targetNetSol != null && stats.net_sol != null) {
    if (stats.net_sol < targetNetSol - 0.5) return 'DEGRADING';
    if (stats.net_sol >= targetNetSol * 0.7) return 'ON-TRACK';
    if (targetN != null && stats.n_closed >= targetN) return 'DEGRADING';
    return 'OPEN';
  }
  if (targetSolMo != null && stats.sol_per_mo != null) {
    if (stats.sol_per_mo < targetSolMo - 1) return 'DEGRADING';
    if (stats.sol_per_mo >= targetSolMo * 0.7) return 'ON-TRACK';
    if (targetN != null && stats.n_closed >= targetN) return 'DEGRADING';
    return 'OPEN';
  }

  // Legacy median path — kept for backwards-compat with pre-2026-05-12 entries.
  if (targetMedian != null) {
    const liveMedian = stats.median;
    if (liveMedian == null) return 'OPEN';
    if (liveMedian < targetMedian - 5) return 'DEGRADING';
    if (liveMedian >= targetMedian * 0.7) return 'ON-TRACK';
    if (targetN != null && stats.n_closed >= targetN) return 'DEGRADING';
    return 'OPEN';
  }

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
    const stats: PerStrategyStats = statsById.get(e.strategy_id) ?? {
      n_closed: 0, median: null, mean: null, win_rate: null,
      net_sol: null, sol_per_mo: null, drop_top3: null,
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
        net_sol: stats.net_sol,
        sol_per_mo: stats.sol_per_mo,
        drop_top3: stats.drop_top3,
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
      'kill_criterion supports SOL-denominated forms (preferred 2026-05-12): "n>=N and net_sol<X", "net_sol<X", "n>=N and sol_per_mo<X", "sol_per_mo<X", "n>=N and drop_top3<X" — plus legacy "n>=N and median<X", "median<X", "win_rate<X". Unparsed criteria never trip the HIT-KILL badge.',
      'Predictions: prefer target_net_sol + target_sol_per_mo + target_drop_top3 (matches the Promotion Readiness scorecard bar: n≥100 · drop_top3>0 · total≥0.5 SOL · monthly≥3.75 SOL). target_median_net_pct kept for backwards-compat with pre-2026-05-12 entries.',
      'Push journal-upsert / journal-update / journal-delete commands via strategy-commands.json on main; the bot ingests on the next sync cycle (~2 min).',
    ],
  };
}
