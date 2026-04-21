/**
 * src/db/backfill-v3-metrics.ts
 *
 * Populates max_tick_drop_0_30 and sum_abs_returns_0_30 on existing
 * graduation_momentum rows that predate the T+30 compute changes in
 * price-collector.ts. Idempotent via the `WHERE max_tick_drop_0_30 IS NULL`
 * guard, so it's safe to invoke on every boot.
 *
 * Helpers duplicate computeMaxTickDrop / computeSumAbsReturns from
 * price-collector.ts — importing there pulls in the whole collector
 * (Connection, rpc-limiter, etc.) which is overkill for a one-off
 * DB backfill that runs before the collector starts.
 */

import type Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('backfill-v3-metrics');

function maxTickDrop(pcts: number[]): number {
  if (pcts.length < 2) return 0;
  let worst = 0;
  for (let i = 1; i < pcts.length; i++) {
    const drop = pcts[i] - pcts[i - 1];
    if (drop < worst) worst = drop;
  }
  return worst;
}

function sumAbsReturns(pcts: number[]): number {
  if (pcts.length < 2) return 0;
  let acc = 0;
  for (let i = 1; i < pcts.length; i++) acc += Math.abs(pcts[i] - pcts[i - 1]);
  return acc;
}

type BackfillRow = {
  graduation_id: number;
  pct_t5: number | null;
  pct_t10: number | null;
  pct_t15: number | null;
  pct_t20: number | null;
  pct_t25: number | null;
  pct_t30: number | null;
};

export function backfillV3Metrics(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT graduation_id, pct_t5, pct_t10, pct_t15, pct_t20, pct_t25, pct_t30
    FROM graduation_momentum
    WHERE max_tick_drop_0_30 IS NULL
      AND pct_t30 IS NOT NULL
  `).all() as BackfillRow[];

  if (rows.length === 0) {
    logger.debug('No rows need v3 metrics backfill');
    return;
  }

  const upd = db.prepare(`
    UPDATE graduation_momentum
    SET max_tick_drop_0_30 = ?,
        sum_abs_returns_0_30 = ?
    WHERE graduation_id = ?
  `);

  let updated = 0;
  const tx = db.transaction((rs: BackfillRow[]) => {
    for (const r of rs) {
      const all: (number | null)[] = [0, r.pct_t5, r.pct_t10, r.pct_t15, r.pct_t20, r.pct_t25, r.pct_t30];
      const valid = all.filter((v): v is number => v !== null);
      if (valid.length < 2) continue;
      upd.run(
        +maxTickDrop(valid).toFixed(3),
        +sumAbsReturns(valid).toFixed(3),
        r.graduation_id,
      );
      updated++;
    }
  });
  tx(rows);

  logger.info({ scanned: rows.length, updated }, 'v3 metrics backfill complete');
}
