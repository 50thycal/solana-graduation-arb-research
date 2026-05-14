/**
 * Backfill `by_strategy_daily` snapshots into legacy daily_reports rows.
 *
 * The /report dashboard's per-strategy history chart, Recent Reports panel
 * (Net SOL / Avg Score / # Promotable columns), and the By-Strategy panel's
 * "all-time high / low score" cells all read from
 * `recent_reports[*].summary.by_strategy_daily`. That field didn't exist
 * before the 2026-05-13 schema change, so legacy rows render as "—" or
 * "history accumulating". This script reconstructs the snapshot from
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
 * Usage:
 *   npx ts-node src/api/backfill-snapshot.ts [--dry-run]
 */

import path from 'path';
import { initDatabase } from '../db/schema';
import { listDailyReports, patchDailyReport, type DailyReportRow } from '../db/queries';
import { computeLeaveOneOutPnl } from './leave-one-out-pnl';
import {
  buildReadinessRowExported,
  computeTradingDayWindowExported,
  type PerStrategyDailySnapshot,
  type ActiveStrategyEntry,
} from './daily-report';

interface RawDailyTradeRow {
  strategy_id: string | null;
  execution_mode: string | null;
  net_profit_sol: number | null;
}

function aggregateTrades(
  db: import('better-sqlite3').Database,
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

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  const db = initDatabase(dataDir);

  const rows = listDailyReports(db, 365) as DailyReportRow[];
  console.log(`[backfill] Found ${rows.length} daily_reports rows. Dry-run=${dryRun}`);

  let updated = 0;
  let skipped = 0;
  for (const row of [...rows].reverse()) { // oldest → newest
    // Trading-day window for this date (06:00 CT → 06:00 CT next day).
    const { startSec, endSec, yesterdayStartSec } = computeTradingDayWindowExported(row.date);

    // Today + yesterday trade activity within the window.
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

    // Skip rows that already have a non-empty snapshot — avoids overwriting
    // post-rollout days with reconstructed-but-less-rich data.
    const existingPatterns = row.patterns_json ? JSON.parse(row.patterns_json) : null;
    if (existingPatterns
      && typeof existingPatterns === 'object'
      && Array.isArray((existingPatterns as { by_strategy_daily?: unknown }).by_strategy_daily)
      && ((existingPatterns as { by_strategy_daily: unknown[] }).by_strategy_daily.length > 0)) {
      skipped += 1;
      continue;
    }

    if (snapshot.length === 0) {
      console.log(`[backfill] ${row.date}: no trade activity → skipped`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`[backfill] ${row.date}: would write ${snapshot.length} snapshot rows (dry-run)`);
    } else {
      const res = patchDailyReport(db, row.date, { by_strategy_daily: snapshot });
      if (!res.ok) {
        console.error(`[backfill] ${row.date}: ERROR ${res.error}`);
        continue;
      }
      console.log(`[backfill] ${row.date}: wrote ${snapshot.length} snapshot rows`);
      updated += 1;
    }
  }

  console.log(`[backfill] Done. updated=${updated} skipped=${skipped}`);
  // Suppress an unused import for ActiveStrategyEntry — it's exported alongside
  // PerStrategyDailySnapshot from daily-report.ts; the type isn't reconstructed
  // here but keeping the import documents which types this backfill could
  // populate in future.
  void ({} as ActiveStrategyEntry);
}

main().catch(err => {
  console.error('[backfill] FATAL', err);
  process.exit(1);
});
