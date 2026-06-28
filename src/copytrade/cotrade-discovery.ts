import Database from 'better-sqlite3';
import { upsertCandidate } from './queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('cotrade-discovery');

/**
 * Co-trade discovery (Idea 2 — winner-graph snowball).
 *
 * The existing ("OG") discovery seeds candidates from our own graduation columns
 * (firstbuyer / dev / creator / 0-30s snipers) — a huge, mostly-stale pool with a
 * weak prior. This method instead asks the highest-signal question we can answer
 * for free: "which wallets repeatedly buy the same graduated tokens, early,
 * ALONGSIDE wallets we've already PROVEN are smart?" Guilt by association with the
 * proven smart set is a far stronger prior than raw activity, so the expensive
 * scorer can be pointed at a few hundred high-prior wallets instead of 75k.
 *
 * Pure SQL over data we already collect (competition_signals ⋈ wallet_scores) —
 * ZERO RPC. Runs on the worker's slow tick. It does NOT lower the bar: a wallet it
 * finds is added as a (prioritized) candidate and must still clear the same
 * money-edge scoring gate to ever be traded. Its only job is to change WHO we look
 * at, not WHAT counts as smart.
 *
 * A/B division (kept airtight): a discovered wallet is upserted into
 * wallet_candidates with source='cotrade_graph', which — because OG seeding uses
 * ON CONFLICT DO NOTHING — sticks ONLY when the OG seed never saw the wallet. So
 *   source = 'cotrade_graph'  ⟺  ONLY the co-trade method surfaced this address
 * and the trading cohorts (og_smart vs cotrade) are disjoint by construction.
 */

const EARLY_WINDOW_SEC = 30;
const MIN_DISTINCT_WINNERS = 2;   // must co-trade with >=2 distinct proven winners
const MAX_CANDIDATES = 2000;      // cap the write set per run (priority routes scoring)

// Same money-edge definition as getSmartSet() — keep in sync.
const SMART_GATE =
  `total_realized_sol_drop_top3 > 0 AND monthly_run_rate_sol >= 3.75 AND total_realized_sol >= 0.5`;

export interface CotradeRow {
  address: string;
  n_distinct_winners: number;
  n_cotrade_grads: number;
  cotrade_score: number;
  og_overlap: number;
}

/**
 * Recompute the co-trade candidate set and persist it. Returns counts for logging.
 * Idempotent — fully rebuilds cotrade_candidates each run from current winners.
 */
export function computeCotradeDiscovery(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
): { found: number; new_candidates: number; overlap: number } {
  let rows: Array<{ cand: string; n_winners: number; n_grads: number }> = [];
  try {
    rows = db.prepare(`
      WITH smart AS (
        SELECT address FROM wallet_scores WHERE ${SMART_GATE}
      ),
      winner_grads AS (
        SELECT cs.graduation_id AS gid, cs.wallet_address AS sw
        FROM competition_signals cs
        JOIN smart s ON s.address = cs.wallet_address
        WHERE cs.action = 'buy'
          AND cs.seconds_since_graduation >= 0
          AND cs.seconds_since_graduation <= ${EARLY_WINDOW_SEC}
        GROUP BY cs.graduation_id, cs.wallet_address
      )
      SELECT cs2.wallet_address AS cand,
             COUNT(DISTINCT wg.sw)  AS n_winners,
             COUNT(DISTINCT cs2.graduation_id) AS n_grads
      FROM competition_signals cs2
      JOIN winner_grads wg ON wg.gid = cs2.graduation_id
      WHERE cs2.action = 'buy'
        AND cs2.seconds_since_graduation >= 0
        AND cs2.seconds_since_graduation <= ${EARLY_WINDOW_SEC}
        AND cs2.wallet_address IS NOT NULL
        AND cs2.wallet_address NOT IN (SELECT address FROM smart)
      GROUP BY cs2.wallet_address
      HAVING n_winners >= ${MIN_DISTINCT_WINNERS}
      ORDER BY n_winners DESC, n_grads DESC
      LIMIT ${MAX_CANDIDATES}
    `).all() as Array<{ cand: string; n_winners: number; n_grads: number }>;
  } catch (err) {
    // wallet_scores / competition_signals may be missing on an older DB.
    logger.warn('Co-trade discovery query failed: %s', err instanceof Error ? err.message : String(err));
    return { found: 0, new_candidates: 0, overlap: 0 };
  }

  const srcStmt = db.prepare(`SELECT source FROM wallet_candidates WHERE address = ?`);
  const upCotrade = db.prepare(`
    INSERT INTO cotrade_candidates (address, n_distinct_winners, n_cotrade_grads, cotrade_score, og_overlap, first_added, updated_at)
    VALUES (@address, @n_winners, @n_grads, @score, @overlap, @now, @now)
    ON CONFLICT(address) DO UPDATE SET
      n_distinct_winners = excluded.n_distinct_winners,
      n_cotrade_grads = excluded.n_cotrade_grads,
      cotrade_score = excluded.cotrade_score,
      og_overlap = excluded.og_overlap,
      updated_at = excluded.updated_at
  `);

  let newCands = 0;
  let overlap = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      // Try to register it as a candidate tagged cotrade_graph. This sticks only
      // if the OG seed never saw it (ON CONFLICT DO NOTHING in upsertCandidate).
      upsertCandidate(db, r.cand, 'cotrade_graph', now);
      const src = (srcStmt.get(r.cand) as { source: string } | undefined)?.source ?? '';
      const isOverlap = src !== 'cotrade_graph' ? 1 : 0; // OG also found it
      if (isOverlap) overlap++; else newCands++;
      upCotrade.run({
        address: r.cand,
        n_winners: r.n_winners,
        n_grads: r.n_grads,
        score: r.n_winners, // primary signal: distinct proven winners co-traded with
        overlap: isOverlap,
        now,
      });
    }
  });
  tx();

  logger.info('Co-trade discovery: %d found (%d cotrade-exclusive, %d OG-overlap)', rows.length, newCands, overlap);
  return { found: rows.length, new_candidates: newCands, overlap };
}

export interface CotradeDiscoveryData {
  generated_at: string;
  method: 'cotrade-graph-snowball';
  params: { early_window_sec: number; min_distinct_winners: number };
  summary: {
    total_cotrade_candidates: number;
    cotrade_exclusive: number;       // source='cotrade_graph' (OG never found them)
    og_overlap: number;              // both methods found them
    cotrade_scored: number;          // cotrade-exclusive wallets that have been scored
    cotrade_smart: number;           // cotrade-exclusive wallets passing the money-edge gate (the tradeable set)
  };
  top: Array<{
    address: string; n_distinct_winners: number; n_cotrade_grads: number;
    og_overlap: number; scored: boolean; is_smart: boolean;
  }>;
}

/** Read-only summary for cotrade-discovery.json + the /copy-trades page. Cheap SQL. */
export function getCotradeDiscovery(db: Database.Database): CotradeDiscoveryData {
  const generated_at = new Date().toISOString();
  const base: CotradeDiscoveryData = {
    generated_at,
    method: 'cotrade-graph-snowball',
    params: { early_window_sec: EARLY_WINDOW_SEC, min_distinct_winners: MIN_DISTINCT_WINNERS },
    summary: { total_cotrade_candidates: 0, cotrade_exclusive: 0, og_overlap: 0, cotrade_scored: 0, cotrade_smart: 0 },
    top: [],
  };
  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN og_overlap = 0 THEN 1 ELSE 0 END) AS exclusive,
        SUM(CASE WHEN og_overlap = 1 THEN 1 ELSE 0 END) AS overlap
      FROM cotrade_candidates
    `).get() as { total: number; exclusive: number | null; overlap: number | null };
    base.summary.total_cotrade_candidates = counts.total ?? 0;
    base.summary.cotrade_exclusive = counts.exclusive ?? 0;
    base.summary.og_overlap = counts.overlap ?? 0;

    // Of the cotrade-EXCLUSIVE wallets (source='cotrade_graph'): how many scored,
    // and how many cleared the money-edge gate (the actually-tradeable cohort).
    const scored = db.prepare(`
      SELECT
        COUNT(*) AS scored,
        SUM(CASE WHEN ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5 THEN 1 ELSE 0 END) AS smart
      FROM cotrade_candidates cc
      JOIN wallet_candidates wc ON wc.address = cc.address AND wc.source = 'cotrade_graph'
      JOIN wallet_scores ws ON ws.address = cc.address
    `).get() as { scored: number | null; smart: number | null };
    base.summary.cotrade_scored = scored.scored ?? 0;
    base.summary.cotrade_smart = scored.smart ?? 0;

    base.top = (db.prepare(`
      SELECT cc.address, cc.n_distinct_winners, cc.n_cotrade_grads, cc.og_overlap,
             ws.address IS NOT NULL AS scored,
             (ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5) AS is_smart
      FROM cotrade_candidates cc
      LEFT JOIN wallet_scores ws ON ws.address = cc.address
      ORDER BY cc.cotrade_score DESC, cc.n_cotrade_grads DESC
      LIMIT 50
    `).all() as Array<Record<string, number | string>>).map((r) => ({
      address: r.address as string,
      n_distinct_winners: r.n_distinct_winners as number,
      n_cotrade_grads: r.n_cotrade_grads as number,
      og_overlap: r.og_overlap as number,
      scored: !!r.scored,
      is_smart: !!r.is_smart,
    }));
  } catch (err) {
    logger.warn('getCotradeDiscovery failed: %s', err instanceof Error ? err.message : String(err));
  }
  return base;
}
