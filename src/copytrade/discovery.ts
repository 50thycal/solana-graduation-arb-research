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

/**
 * Recompute candidate `priority` from in-DB signal so the scorer evaluates the
 * wallets most likely to be alpha FIRST (instead of address-sorted order, which
 * is random w.r.t. skill). With ~66k candidates and a small scoring batch, the
 * ordering is what makes Phase 1 tractable.
 *
 * Signal, all already collected by the graduation pipeline:
 *   - buys on PUMP-labeled graduations (being early on winners, repeatedly)
 *   - total distinct graduations bought (raw activity / seriousness)
 *   - first-buyer hits, weighted heavily when the token PUMPed
 *
 * priority = pump_buys*3 + buys*1 + firstbuyer_pump*5 + firstbuyer*1
 *
 * Only wallets WITH signal are updated; the rest keep priority NULL (sorts last).
 * Aggregates are GROUP-BY scans over competition_signals (~hundreds of ms) plus a
 * bounded batch of UPDATEs — runs on the worker's 6h cadence, off the hot path.
 * Returns the number of wallets whose priority was set.
 */
export function recomputeCandidatePriorities(db: Database.Database): number {
  const priority = new Map<string, number>();

  const addPts = (addr: string | null, pts: number) => {
    if (!addr) return;
    priority.set(addr, (priority.get(addr) ?? 0) + pts);
  };

  try {
    const buyRows = db.prepare(`
      SELECT cs.wallet_address AS w,
             COUNT(DISTINCT cs.graduation_id) AS buys,
             COUNT(DISTINCT CASE WHEN gm.label = 'PUMP' THEN cs.graduation_id END) AS pump_buys
      FROM competition_signals cs
      JOIN graduation_momentum gm ON gm.graduation_id = cs.graduation_id
      WHERE cs.action = 'buy' AND cs.wallet_address IS NOT NULL
      GROUP BY cs.wallet_address
    `).all() as Array<{ w: string; buys: number; pump_buys: number }>;
    for (const r of buyRows) addPts(r.w, r.pump_buys * 3 + r.buys);
  } catch (err) {
    logger.warn('Priority buy-aggregate failed: %s', err instanceof Error ? err.message : String(err));
  }

  try {
    const fbRows = db.prepare(`
      SELECT firstbuyer_wallet AS w,
             COUNT(*) AS fb,
             COUNT(CASE WHEN label = 'PUMP' THEN 1 END) AS fb_pump
      FROM graduation_momentum
      WHERE firstbuyer_wallet IS NOT NULL
      GROUP BY firstbuyer_wallet
    `).all() as Array<{ w: string; fb: number; fb_pump: number }>;
    for (const r of fbRows) addPts(r.w, r.fb_pump * 5 + r.fb);
  } catch (err) {
    logger.warn('Priority firstbuyer-aggregate failed: %s', err instanceof Error ? err.message : String(err));
  }

  // Co-trade discovery (Idea 2): wallets that buy alongside proven smart wallets
  // get a strong priority boost so the scorer reaches them FAST instead of after
  // the 75k OG backlog — the whole point of the method is to point scoring at
  // high-prior wallets. Weighted heavily (×8 per distinct proven winner) because
  // "co-trades with N proven winners" is a much stronger prior than raw activity.
  try {
    const ctRows = db.prepare(
      `SELECT address AS w, n_distinct_winners AS nw FROM cotrade_candidates`
    ).all() as Array<{ w: string; nw: number }>;
    for (const r of ctRows) addPts(r.w, r.nw * 8);
  } catch (err) {
    logger.warn('Priority cotrade-aggregate failed: %s', err instanceof Error ? err.message : String(err));
  }

  // Live-tape (Idea 1): wallets promoted off the PumpSwap tape are genuinely-new
  // (OG never saw them) and already passed an activity+profit screen — they are the
  // wallets MOST likely to be tradeable, so they must be scored BEFORE the 74k
  // random OG backlog. The old +20 boost left them buried behind high-signal OG
  // candidates (which reach ~64), so they never got scored. A large flat boost puts
  // every screened live-tape wallet at the front of the never-scored queue.
  try {
    const ltRows = db.prepare(
      `SELECT address AS w FROM wallet_candidates WHERE source = 'live_tape'`
    ).all() as Array<{ w: string }>;
    for (const r of ltRows) addPts(r.w, 1000);
  } catch (err) {
    logger.warn('Priority live-tape-aggregate failed: %s', err instanceof Error ? err.message : String(err));
  }

  const stmt = db.prepare(`UPDATE wallet_candidates SET priority = @p WHERE address = @a`);
  const tx = db.transaction(() => {
    for (const [a, p] of priority) stmt.run({ a, p });
  });
  tx();

  logger.info('Recomputed priority for %d candidates with signal', priority.size);
  return priority.size;
}
