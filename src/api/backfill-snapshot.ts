/**
 * Backfill `by_strategy_daily` snapshots into legacy daily_reports rows.
 *
 * The /report dashboard's per-strategy history chart, Recent Reports panel
 * (Net SOL / Avg Score / # Promotable columns), and the By-Strategy panel's
 * "all-time high / low score" cells all read from
 * `recent_reports[*].summary.by_strategy_daily`. That field didn't exist
 * before the 2026-05-13 schema change, so legacy rows render as "—" or
 * "history accumulating". This module reconstructs the snapshot from
 * `trades_v2` for every legacy date so the dashboard works with full history
 * immediately.
 *
 * Snapshot reconstruction strategy:
 *   - For each daily_reports row, compute the trading-day window (06:00 CT →
 *     06:00 CT next day).
 *   - Group trades_v2 by `(strategy_id, execution_mode)` within that window
 *     → n_trades_today + net_sol_today + yesterday counterparts.
 *   - Use computeLeaveOneOutPnl(db, asOfSec=end-of-day) to derive lifetime
 *     fields and the readiness score AS OF that date (not lifetime-now).
 *   - patchDailyReport writes only the snapshot field; narrative, winners,
 *     recommendations, etc. are preserved.
 *
 * Active strategies snapshot for legacy days is NOT reconstructed —
 * historical enabled flags aren't recoverable. The roster-diff panel will
 * show empty for any day predating the rollout; that's accurate.
 *
 * Two entry points:
 *   - CLI: npx ts-node src/api/backfill-snapshot.ts [--dry-run]
 *   - HTTP: POST /api/admin/backfill-snapshot   (calls backfillSnapshots(db))
 */

import path from 'path';
import type Database from 'better-sqlite3';
import { initDatabase } from '../db/schema';
import { listDailyReports, patchDailyReport, type DailyReportRow } from '../db/queries';
import { computeLeaveOneOutPnl } from './leave-one-out-pnl';
import {
  buildReadinessRowExported,
  computeTradingDayWindowExported,
  type PerStrategyDailySnapshot,
} from './daily-report';

interface RawDailyTradeRow {
  strategy_id: string | null;
  execution_mode: string | null;
  net_profit_sol: number | null;
}

function aggregateTrades(
  db: Database.Database,
  startSec: number,
  endSec: number,
): Map<string, { strategy_id: string; execution_mode: string; n: number; net_sol: number }> {
  const rows = db.prepare(`
    SELECT strategy_id,
           COALESCE(execution_mode, 'paper') AS execution_mode,
           net_profit_sol
    FROM trades_v2
    WHERE status = 'closed'
      AND exit_timestamp IS NOT NULL
      AND exit_timestamp >= ?
      AND exit_timestamp < ?
      AND (archived IS NULL OR archived = 0)
  `).all(startSec, endSec) as RawDailyTradeRow[];

  const out = new Map<string, { strategy_id: string; execution_mode: string; n: number; net_sol: number }>();
  for (const r of rows) {
    if (!r.strategy_id) continue;
    const mode = r.execution_mode ?? 'paper';
    const key = `${r.strategy_id}|${mode}`;
    const bucket = out.get(key);
    if (bucket) {
      bucket.n += 1;
      bucket.net_sol += r.net_profit_sol ?? 0;
    } else {
      out.set(key, { strategy_id: r.strategy_id, execution_mode: mode, n: 1, net_sol: r.net_profit_sol ?? 0 });
    }
  }
  return out;
}

export interface BackfillSummary {
  total_rows: number;
  updated: number;
  skipped: number;
  dry_run: boolean;
  per_date: Array<{ date: string; outcome: 'updated' | 'skipped' | 'no-activity' | 'error'; n_rows: number; error?: string }>;
}

/**
 * Walk every daily_reports row (oldest → newest), reconstruct the
 * per-strategy snapshot, and patch it in. Idempotent: rows that already
 * have a snapshot are skipped unless `overwrite: true`.
 */
export function backfillSnapshots(
  db: Database.Database,
  opts: { dryRun?: boolean; overwrite?: boolean; log?: (msg: string) => void } = {},
): BackfillSummary {
  const log = opts.log ?? (() => {});
  const rows = listDailyReports(db, 365) as DailyReportRow[];
  log(`[backfill] Found ${rows.length} daily_reports rows. dry_run=${!!opts.dryRun} overwrite=${!!opts.overwrite}`);

  const summary: BackfillSummary = {
    total_rows: rows.length,
    updated: 0,
    skipped: 0,
    dry_run: !!opts.dryRun,
    per_date: [],
  };

  for (const row of [...rows].reverse()) { // oldest → newest
    const { startSec, endSec, yesterdayStartSec } = computeTradingDayWindowExported(row.date);
    const todayByMode = aggregateTrades(db, startSec, endSec);
    const yesterdayByMode = aggregateTrades(db, yesterdayStartSec, startSec);

    // Lifetime metrics + readiness AS OF end-of-day for this row's date.
    const loo = computeLeaveOneOutPnl(db, endSec);
    const looByMode = new Map(loo.rows.map(r => [`${r.strategy_id}|${r.execution_mode}`, r]));

    const snapshotKeys = new Set<string>();
    for (const r of loo.rows) snapshotKeys.add(`${r.strategy_id}|${r.execution_mode}`);
    for (const k of todayByMode.keys()) snapshotKeys.add(k);

    const snapshot: PerStrategyDailySnapshot[] = [];
    for (const key of snapshotKeys) {
      const [sid, mode] = key.split('|');
      const looRow = looByMode.get(key);
      const today = todayByMode.get(key);
      const yest = yesterdayByMode.get(key);
      const readiness = looRow ? buildReadinessRowExported(looRow) : null;
      snapshot.push({
        strategy_id: sid,
        execution_mode: mode,
        label: looRow?.label ?? sid,
        enabled: looRow?.enabled ?? false,
        n_trades_today: today?.n ?? 0,
        n_trades_yesterday: yest?.n ?? 0,
        net_sol_today: today != null ? +today.net_sol.toFixed(4) : 0,
        net_sol_yesterday: yest != null ? +yest.net_sol.toFixed(4) : 0,
        readiness_score: readiness?.readiness_score ?? null,
        edge_flag: null, // edge-decay is a real-time signal; backfill leaves it unset
        readiness_score_yesterday: null, // not reconstructable retroactively
        readiness_score_alltime_high: null,
        readiness_score_alltime_low: null,
        promotable: readiness?.promotable ?? false,
        n_trades_lifetime: looRow?.n_trades ?? 0,
        total_net_sol_lifetime: looRow?.total_net_sol ?? 0,
        total_net_sol_drop_top3: looRow?.total_net_sol_drop_top3 ?? 0,
        monthly_run_rate_sol: looRow?.monthly_run_rate_sol ?? 0,
      });
    }

    // Skip rows that already have a non-empty snapshot unless overwriting.
    if (!opts.overwrite) {
      let parsed: unknown = null;
      try { parsed = row.patterns_json ? JSON.parse(row.patterns_json) : null; } catch { /* noop */ }
      if (parsed && typeof parsed === 'object'
        && Array.isArray((parsed as { by_strategy_daily?: unknown }).by_strategy_daily)
        && ((parsed as { by_strategy_daily: unknown[] }).by_strategy_daily.length > 0)) {
        log(`[backfill] ${row.date}: snapshot present → skipped`);
        summary.skipped += 1;
        summary.per_date.push({ date: row.date, outcome: 'skipped', n_rows: 0 });
        continue;
      }
    }

    if (snapshot.length === 0) {
      log(`[backfill] ${row.date}: no trade activity → skipped`);
      summary.skipped += 1;
      summary.per_date.push({ date: row.date, outcome: 'no-activity', n_rows: 0 });
      continue;
    }

    if (opts.dryRun) {
      log(`[backfill] ${row.date}: would write ${snapshot.length} snapshot rows (dry-run)`);
      summary.per_date.push({ date: row.date, outcome: 'updated', n_rows: snapshot.length });
      continue;
    }

    const res = patchDailyReport(db, row.date, { by_strategy_daily: snapshot });
    if (!res.ok) {
      log(`[backfill] ${row.date}: ERROR ${res.error}`);
      summary.per_date.push({ date: row.date, outcome: 'error', n_rows: 0, error: res.error });
      continue;
    }
    log(`[backfill] ${row.date}: wrote ${snapshot.length} snapshot rows`);
    summary.updated += 1;
    summary.per_date.push({ date: row.date, outcome: 'updated', n_rows: snapshot.length });
  }

  log(`[backfill] Done. updated=${summary.updated} skipped=${summary.skipped}`);
  return summary;
}

// CLI entry point — only fires when this module is invoked directly via
// `ts-node src/api/backfill-snapshot.ts`. Importing it from index.ts does NOT
// trigger this branch.
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const overwrite = process.argv.includes('--overwrite');
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  const db = initDatabase(dataDir);
  const summary = backfillSnapshots(db, { dryRun, overwrite, log: console.log });
  console.log(JSON.stringify({ updated: summary.updated, skipped: summary.skipped }, null, 2));
}
