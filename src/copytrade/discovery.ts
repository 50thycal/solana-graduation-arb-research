import Database from 'better-sqlite3';
import { upsertCandidate, countCandidates } from './queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copytrade-discovery');

/**
 * Seed wallet candidates from existing DB data at ZERO new RPC cost (Phase 1
 * cold start). Every address we've already observed is a candidate; the PnL
 * engine re-verifies each one's realized P&L from chain regardless of source.
 *
 * Sources, all already collected by the graduation pipeline:
 *   - competition_signals.wallet_address — snipers / early post-grad buyers
 *   - graduation_momentum.firstbuyer_wallet — first non-bot buyer per grad
 *   - graduation_momentum.dev_wallet_address / creator_wallet_address
 *
 * Returns the number of NEW candidates inserted this run.
 */
export function seedCandidatesFromDb(db: Database.Database, now: number = Math.floor(Date.now() / 1000)): number {
  const before = countCandidates(db);

  const sources: Array<{ sql: string; tag: string }> = [
    {
      tag: 'competition_signal',
      sql: `SELECT DISTINCT wallet_address AS addr FROM competition_signals
            WHERE wallet_address IS NOT NULL AND action = 'buy'`,
    },
    {
      tag: 'firstbuyer',
      sql: `SELECT DISTINCT firstbuyer_wallet AS addr FROM graduation_momentum
            WHERE firstbuyer_wallet IS NOT NULL`,
    },
    {
      tag: 'dev_wallet',
      sql: `SELECT DISTINCT dev_wallet_address AS addr FROM graduation_momentum
            WHERE dev_wallet_address IS NOT NULL`,
    },
    {
      tag: 'creator_wallet',
      sql: `SELECT DISTINCT creator_wallet_address AS addr FROM graduation_momentum
            WHERE creator_wallet_address IS NOT NULL`,
    },
  ];

  const tx = db.transaction(() => {
    for (const src of sources) {
      let rows: Array<{ addr: string | null }> = [];
      try {
        rows = db.prepare(src.sql).all() as Array<{ addr: string | null }>;
      } catch (err) {
        // A source table/column may not exist on an older DB — skip gracefully.
        logger.warn('Discovery source %s failed: %s', src.tag,
          err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const r of rows) {
        if (r.addr) upsertCandidate(db, r.addr, src.tag, now);
      }
    }
  });
  tx();

  const added = countCandidates(db) - before;
  logger.info('Discovery seed complete: +%d new candidates (%d total)', added, countCandidates(db));
  return added;
}
