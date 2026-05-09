/**
 * src/api/pipeline-data.ts
 *
 * Graduation → trade pipeline funnel view.
 *
 * For each recent graduation: did it start a price observation? Was it stale?
 * Did T+30 fire? Did any strategies trade or skip, and why?
 *
 * Status per graduation:
 *   TRADED   — at least one strategy opened a trade
 *   FILTERED — strategies ran but every one rejected via filter / entry gate
 *   NO_EVAL  — price collector rejected before strategy eval (stale or T+30 timeout)
 */

import type Database from 'better-sqlite3';

const PIPELINE_LIMIT = 100;

export function computePipelineData(
  db: Database.Database,
  listenerStats: any | null = null,
  activeStrategyCount: number = 0,
) {
  // Lower-bound the trade_skips / trades_v2 aggregations to the recent ID
  // window so they don't full-scan the whole tables on every dashboard hit.
  // Without this bound the subqueries materialize a GROUP BY over every row
  // ever recorded — which used to be cheap but now (~6k+ trades, many more
  // skips) was timing out the request at Railway's 4-min edge limit.
  const minIdRow = db.prepare(
    `SELECT id FROM graduations ORDER BY id DESC LIMIT 1 OFFSET ?`
  ).get(PIPELINE_LIMIT - 1) as { id: number } | undefined;
  const minGradId = minIdRow?.id ?? 0;

  const grads = (db.prepare(`
    SELECT
      g.id,
      g.mint,
      datetime(g.created_at, 'unixepoch') as grad_time,
      m.bc_velocity_sol_per_min  AS vel,
      m.top5_wallet_pct          AS top5,
      m.dev_wallet_pct           AS dev_pct,
      m.pct_t30,
      m.pct_t300,
      m.label,
      COALESCE(s.skip_count,  0) AS skip_count,
      COALESCE(s.uniq_reasons,'') AS skip_reasons,
      COALESCE(t.trade_count, 0) AS trade_count
    FROM graduations g
    LEFT JOIN graduation_momentum m ON m.graduation_id = g.id
    LEFT JOIN (
      SELECT graduation_id,
             COUNT(*)                             AS skip_count,
             GROUP_CONCAT(DISTINCT skip_reason)  AS uniq_reasons
      FROM trade_skips
      WHERE graduation_id >= ?
      GROUP BY graduation_id
    ) s ON s.graduation_id = g.id
    LEFT JOIN (
      SELECT graduation_id, COUNT(*) AS trade_count
      FROM trades_v2
      WHERE graduation_id >= ?
      GROUP BY graduation_id
    ) t ON t.graduation_id = g.id
    WHERE g.id >= ?
    ORDER BY g.id DESC
    LIMIT ?
  `).all(minGradId, minGradId, minGradId, PIPELINE_LIMIT) as any[]).map(g => ({
    ...g,
    status: g.trade_count > 0 ? 'TRADED'
          : g.skip_count  > 0 ? 'FILTERED'
          : 'NO_EVAL',
  }));

  const dpc = listenerStats?.directPriceCollector ?? null;
  const sessionStats = dpc ? {
    verified_graduations:   listenerStats.totalVerifiedGraduations ?? 0,
    observations_started:   dpc.totalStarted          ?? 0,
    stale_graduations:      dpc.totalStaleGraduations  ?? 0,
    t30_callbacks_fired:    dpc.t30CallbacksFired       ?? 0,
    t30_timeouts:           dpc.totalT30Timeouts        ?? 0,
  } : null;

  return {
    generated_at: new Date().toISOString(),
    session_stats: sessionStats,
    active_strategy_count: activeStrategyCount,
    grads,
  };
}

export type PipelineData = ReturnType<typeof computePipelineData>;
