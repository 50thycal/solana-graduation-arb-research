import Database from 'better-sqlite3';
import { upsertCandidate, COTRADE_COHORT_MIN_WINNERS } from './queries';
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
 * A/B division (corrected 2026-06-28). The original design split by "who
 * DISCOVERED the wallet" (wallet_candidates.source). That was structurally empty:
 * co-trade reads competition_signals — the SAME 0-30s window the OG seed reads —
 * so every wallet it finds was already OG-seeded (cotrade_exclusive was always 0).
 * Finding genuinely-unseen wallets needs a NEW data source (RPC fetch of co-buyers,
 * or the live tape) — a separate build, not this.
 *
 * So co-trade is reframed as a wallet-QUALITY SELECTION signal applied to the
 * proven smart set: cotrade_score = # distinct OTHER proven winners a wallet runs
 * with in the early window. The disjoint A/B cohorts (queries.ts) partition the
 * smart set by that score:
 *   cotrade cohort = smart wallets with cotrade_score >= COTRADE_COHORT_MIN_WINNERS
 *                    ("runs with the crowd of proven winners")
 *   og cohort      = the rest of the smart set
 * The hypothesis under test: do smart wallets that cluster with other winners
 * outperform the smart wallets that don't? Both cohorts are real and non-empty.
 *
 * We still register discovered wallets as prioritized candidates (source tag +
 * priority boost) so high-co-trade wallets get SCORED fast — that part was always
 * sound; only the cohort definition changed.
 */

const EARLY_WINDOW_SEC = 30;
const MIN_DISTINCT_WINNERS = 2;   // write floor: only record wallets co-trading with >=2 winners
const MAX_CANDIDATES = 4000;      // cap the write set per run (priority routes scoring)

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
      -- self-exclude (wg.sw != cand) so a smart wallet isn't counted as
      -- co-trading with itself; smart wallets ARE included as candidates so the
      -- signal is defined across the whole smart set, not just non-smart wallets.
      JOIN winner_grads wg ON wg.gid = cs2.graduation_id AND wg.sw != cs2.wallet_address
      WHERE cs2.action = 'buy'
        AND cs2.seconds_since_graduation >= 0
        AND cs2.seconds_since_graduation <= ${EARLY_WINDOW_SEC}
        AND cs2.wallet_address IS NOT NULL
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
  params: { early_window_sec: number; cohort_min_winners: number };
  summary: {
    total_cotrade_candidates: number; // all wallets with a co-trade signal (any tier)
    smart_total: number;              // proven smart wallets (the A/B universe)
    cotrade_cohort: number;           // smart wallets with cotrade_score >= threshold (Idea 2 picks)
    og_cohort: number;                // smart wallets below threshold (the rest of OG's smart set)
  };
  // The cotrade cohort = the actual wallets copy-cotrade-tp100-sl30 trades.
  top: Array<{
    address: string; n_distinct_winners: number; n_cotrade_grads: number;
    scored: boolean; is_smart: boolean; cohort: 'cotrade' | 'og' | null;
  }>;
}

/** Read-only summary for the /copy-trades page. Cheap SQL. Reports the smart-set
 *  split that defines the A/B, plus the top smart wallets by co-trade signal. */
export function getCotradeDiscovery(db: Database.Database): CotradeDiscoveryData {
  const generated_at = new Date().toISOString();
  const thr = COTRADE_COHORT_MIN_WINNERS;
  const GATE = `ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5`;
  const base: CotradeDiscoveryData = {
    generated_at,
    method: 'cotrade-graph-snowball',
    params: { early_window_sec: EARLY_WINDOW_SEC, cohort_min_winners: thr },
    summary: { total_cotrade_candidates: 0, smart_total: 0, cotrade_cohort: 0, og_cohort: 0 },
    top: [],
  };
  try {
    base.summary.total_cotrade_candidates =
      (db.prepare(`SELECT COUNT(*) AS c FROM cotrade_candidates`).get() as { c: number }).c ?? 0;

    // The A/B universe: the proven smart set, partitioned by the co-trade signal.
    const split = db.prepare(`
      SELECT
        COUNT(*) AS smart_total,
        SUM(CASE WHEN COALESCE(cc.n_distinct_winners,0) >= @thr THEN 1 ELSE 0 END) AS cotrade_cohort,
        SUM(CASE WHEN COALESCE(cc.n_distinct_winners,0) <  @thr THEN 1 ELSE 0 END) AS og_cohort
      FROM wallet_scores ws
      LEFT JOIN cotrade_candidates cc ON cc.address = ws.address
      WHERE ${GATE}
    `).get({ thr }) as { smart_total: number; cotrade_cohort: number | null; og_cohort: number | null };
    base.summary.smart_total = split.smart_total ?? 0;
    base.summary.cotrade_cohort = split.cotrade_cohort ?? 0;
    base.summary.og_cohort = split.og_cohort ?? 0;

    // Top SMART wallets by co-trade signal — the head of the cotrade cohort.
    base.top = (db.prepare(`
      SELECT cc.address, cc.n_distinct_winners, cc.n_cotrade_grads,
             ws.address IS NOT NULL AS scored,
             (${GATE}) AS is_smart
      FROM cotrade_candidates cc
      LEFT JOIN wallet_scores ws ON ws.address = cc.address
      ORDER BY cc.n_distinct_winners DESC, cc.n_cotrade_grads DESC
      LIMIT 50
    `).all() as Array<Record<string, number | string>>).map((r) => {
      const isSmart = !!r.is_smart;
      const inCotrade = (r.n_distinct_winners as number) >= thr;
      return {
        address: r.address as string,
        n_distinct_winners: r.n_distinct_winners as number,
        n_cotrade_grads: r.n_cotrade_grads as number,
        scored: !!r.scored,
        is_smart: isSmart,
        cohort: isSmart ? (inCotrade ? 'cotrade' as const : 'og' as const) : null,
      };
    });
  } catch (err) {
    logger.warn('getCotradeDiscovery failed: %s', err instanceof Error ? err.message : String(err));
  }
  return base;
}
