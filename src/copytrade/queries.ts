import Database from 'better-sqlite3';
import type { WalletScore, WalletSwap, RoundTrip } from './wallet-pnl';
import { COPYABILITY } from './ranker';

/**
 * Copyability filter as SQL (mirrors ranker.isCopyable). Applied to the COPY paths
 * — the probe watchlist + trading cohorts — so we never copy wallets whose edge we
 * can't mirror (bonding-curve scalpers, sub-5-min holds, ~99%-WR structural edge).
 * Works off the existing venues_json / avg_hold_sec / win_rate, so it takes effect
 * on already-scored wallets with no re-score. Null/unknown → excluded (conservative).
 * Requires the table aliased `ws`. Numeric constants inlined (safe, no user input).
 */
const COPYABLE_SQL = `
  COALESCE(ws.avg_hold_sec, 0) >= ${COPYABILITY.minHoldSec}
  AND COALESCE(ws.win_rate, 1) <= ${COPYABILITY.maxWinRate}
  AND COALESCE(json_extract(ws.venues_json, '$.pumpswap'), 0) * 1.0
      / NULLIF((SELECT SUM(value) FROM json_each(ws.venues_json)), 0) >= ${COPYABILITY.minPumpswapShare}
`;

/**
 * DB helpers for the copy-trade wallet-intelligence tables. Kept in the
 * copytrade module (not src/db/queries.ts) so the subsystem stays isolated —
 * dropping the module removes its data access with it.
 */

export interface WalletCandidate {
  address: string;
  first_seen: number;
  source: string;
  last_refreshed: number | null;
  priority: number | null;
}

/** Insert a candidate if new; never overwrites an existing first_seen/source. */
export function upsertCandidate(
  db: Database.Database,
  address: string,
  source: string,
  now: number,
): void {
  db.prepare(`
    INSERT INTO wallet_candidates (address, first_seen, source, last_refreshed)
    VALUES (@address, @now, @source, NULL)
    ON CONFLICT(address) DO NOTHING
  `).run({ address, source, now });
}

export function getCandidates(
  db: Database.Database,
  opts: { staleBeforeTs?: number; limit?: number } = {},
): WalletCandidate[] {
  const limit = opts.limit ?? 500;
  if (opts.staleBeforeTs != null) {
    // Eligible = never scored OR scored long enough ago. Within that, take
    // highest-priority first (NULL priority sorts last under DESC), unscored
    // before stale, oldest-stale as the final tiebreak. This is what makes the
    // scorer work through likely-alpha wallets instead of address order.
    return db.prepare(`
      SELECT * FROM wallet_candidates
      WHERE last_refreshed IS NULL OR last_refreshed < @stale
      ORDER BY (last_refreshed IS NOT NULL) ASC, priority DESC, last_refreshed ASC
      LIMIT @limit
    `).all({ stale: opts.staleBeforeTs, limit }) as WalletCandidate[];
  }
  return db.prepare(`SELECT * FROM wallet_candidates ORDER BY priority DESC, first_seen ASC LIMIT @limit`)
    .all({ limit }) as WalletCandidate[];
}

/** Highest-priority candidates not yet scored — the scorer's upcoming queue. */
export function getTopUnscoredByPriority(
  db: Database.Database,
  limit = 10,
): Array<{ address: string; priority: number | null }> {
  return db.prepare(`
    SELECT address, priority FROM wallet_candidates
    WHERE last_refreshed IS NULL AND priority IS NOT NULL
    ORDER BY priority DESC
    LIMIT ?
  `).all(limit) as Array<{ address: string; priority: number | null }>;
}

export function countCandidates(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM wallet_candidates`).get() as { c: number }).c;
}

export function cacheWalletSwaps(
  db: Database.Database,
  address: string,
  swaps: WalletSwap[],
): void {
  const stmt = db.prepare(`
    INSERT INTO wallet_tx_cache (address, signature, block_time, mint, action, sol_delta, token_delta, venue)
    VALUES (@address, @signature, @block_time, @mint, @action, @sol_delta, @token_delta, @venue)
    ON CONFLICT(address, signature) DO NOTHING
  `);
  const tx = db.transaction((rows: WalletSwap[]) => {
    for (const s of rows) {
      stmt.run({
        address,
        signature: s.signature,
        block_time: s.blockTime,
        mint: s.mint,
        action: s.action,
        sol_delta: s.solDelta,
        token_delta: s.tokenDelta,
        venue: s.venue,
      });
    }
  });
  tx(swaps);
}

/** Load a wallet's cached parsed swaps (oldest-first) — the base for an
 *  INCREMENTAL re-score: merge these with only the newer on-chain swaps instead of
 *  re-fetching the whole history. */
export function getCachedSwaps(db: Database.Database, address: string): WalletSwap[] {
  return (db.prepare(`
    SELECT signature, block_time, mint, action, sol_delta, token_delta, venue
    FROM wallet_tx_cache WHERE address = ? ORDER BY block_time ASC
  `).all(address) as Array<{ signature: string; block_time: number; mint: string; action: string; sol_delta: number; token_delta: number; venue: string }>)
    .map((r) => ({
      signature: r.signature,
      blockTime: r.block_time,
      mint: r.mint,
      action: r.action as 'buy' | 'sell',
      solDelta: r.sol_delta,
      tokenDelta: r.token_delta,
      venue: r.venue,
    }));
}

/** Keep only the newest `max` cached swaps for a wallet (bounds the incrementally
 *  growing cache; the kept window is also the deepest history we score on). */
export function trimWalletCache(db: Database.Database, address: string, max: number): void {
  db.prepare(`
    DELETE FROM wallet_tx_cache
    WHERE address = @address AND signature NOT IN (
      SELECT signature FROM wallet_tx_cache WHERE address = @address
      ORDER BY block_time DESC LIMIT @max
    )
  `).run({ address, max });
}

export function replaceRoundTrips(
  db: Database.Database,
  address: string,
  rts: RoundTrip[],
): void {
  const del = db.prepare(`DELETE FROM wallet_round_trips WHERE address = ?`);
  const ins = db.prepare(`
    INSERT INTO wallet_round_trips (address, mint, open_ts, close_ts, sol_in, sol_out, realized_sol, hold_sec)
    VALUES (@address, @mint, @open_ts, @close_ts, @sol_in, @sol_out, @realized_sol, @hold_sec)
  `);
  const tx = db.transaction(() => {
    del.run(address);
    for (const r of rts) {
      ins.run({
        address,
        mint: r.mint,
        open_ts: r.openTs,
        close_ts: r.closeTs,
        sol_in: r.solIn,
        sol_out: r.solOut,
        realized_sol: r.realizedSol,
        hold_sec: r.holdSec,
      });
    }
  });
  tx();
}

export function upsertWalletScore(
  db: Database.Database,
  score: WalletScore,
  scoredAt: number,
  scanSigs: number | null = null,
): void {
  db.prepare(`
    INSERT INTO wallet_scores (
      address, n_round_trips, total_realized_sol, total_realized_sol_drop_top3,
      median_rt_pct, monthly_run_rate_sol, win_rate, avg_hold_sec, last_active,
      venues_json, scored_at, last_scan_sigs
    ) VALUES (
      @address, @n, @total, @drop3, @median, @monthly, @win, @hold, @last_active,
      @venues, @scored_at, @scan_sigs
    )
    ON CONFLICT(address) DO UPDATE SET
      n_round_trips = excluded.n_round_trips,
      total_realized_sol = excluded.total_realized_sol,
      total_realized_sol_drop_top3 = excluded.total_realized_sol_drop_top3,
      median_rt_pct = excluded.median_rt_pct,
      monthly_run_rate_sol = excluded.monthly_run_rate_sol,
      win_rate = excluded.win_rate,
      avg_hold_sec = excluded.avg_hold_sec,
      last_active = excluded.last_active,
      venues_json = excluded.venues_json,
      scored_at = excluded.scored_at,
      -- keep the deepest scan depth we've ever done (a later shallow incremental
      -- refresh shouldn't downgrade the recorded depth).
      last_scan_sigs = MAX(COALESCE(last_scan_sigs, 0), COALESCE(excluded.last_scan_sigs, 0))
  `).run({
    address: score.address,
    n: score.nRoundTrips,
    total: score.totalRealizedSol,
    drop3: score.totalRealizedSolDropTop3,
    median: score.medianRtPct,
    monthly: score.monthlyRunRateSol,
    win: score.winRate,
    hold: score.avgHoldSec,
    last_active: score.lastActive,
    venues: JSON.stringify(score.venues),
    scored_at: scoredAt,
    scan_sigs: scanSigs,
  });
  db.prepare(`UPDATE wallet_candidates SET last_refreshed = ? WHERE address = ?`)
    .run(scoredAt, score.address);
}

/** Promising-but-n-capped wallets worth a one-shot DEEP rescan: positive realized,
 *  enough round trips to look real but short of the n>=100 bar, and not yet
 *  deep-scanned. These are wallets we likely rejected on the 300-sig depth artifact
 *  (e.g. the +133 SOL / 73-RT wallet). Ordered best-first. */
export function getDeepRescanCandidates(
  db: Database.Database,
  opts: { minTotalSol: number; nLow: number; nHigh: number; deepSigs: number; limit: number },
): string[] {
  return (db.prepare(`
    SELECT address FROM wallet_scores
    WHERE n_round_trips >= @nLow AND n_round_trips < @nHigh
      AND total_realized_sol >= @minTotalSol
      AND COALESCE(last_scan_sigs, 0) < @deepSigs
    ORDER BY total_realized_sol DESC
    LIMIT @limit
  `).all({ ...opts }) as Array<{ address: string }>).map((r) => r.address);
}

export interface WalletScoreRow {
  address: string;
  n_round_trips: number;
  total_realized_sol: number;
  total_realized_sol_drop_top3: number;
  median_rt_pct: number | null;
  monthly_run_rate_sol: number | null;
  win_rate: number | null;
  avg_hold_sec: number | null;
  last_active: number | null;
  venues_json: string | null;
  scored_at: number;
}

export function getTopWalletScores(db: Database.Database, limit = 50): WalletScoreRow[] {
  return db.prepare(`
    SELECT * FROM wallet_scores
    ORDER BY monthly_run_rate_sol DESC NULLS LAST
    LIMIT ?
  `).all(limit) as WalletScoreRow[];
}

/**
 * The "smart set" used by the smart-money analysis: wallets whose money-edge is
 * real — survives drop_top3, clears the monthly bar, positive total — but with
 * n / recency RELAXED vs the full promotion gate (leaderboard.ts), so there are
 * enough wallets to study which tokens they pick. The follow-list still uses the
 * strict gate; this is purely the analysis population.
 */
export function getSmartSet(db: Database.Database): WalletScoreRow[] {
  return db.prepare(`
    SELECT * FROM wallet_scores
    WHERE total_realized_sol_drop_top3 > 0
      AND monthly_run_rate_sol >= 3.75
      AND total_realized_sol >= 0.5
    ORDER BY monthly_run_rate_sol DESC NULLS LAST
  `).all() as WalletScoreRow[];
}

const SMART_MONEY_CACHE_KEY = 'smart_money_analysis';

/** Persist the computed smart-money analysis JSON blob (bot_settings k/v). */
export function setSmartMoneyCache(db: Database.Database, json: string): void {
  db.prepare(`
    INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SMART_MONEY_CACHE_KEY, json);
}

/** Read the cached smart-money analysis JSON blob, or null if not computed yet. */
export function getSmartMoneyCacheRaw(db: Database.Database): string | null {
  const row = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`)
    .get(SMART_MONEY_CACHE_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Copy-trade B: write graduation_momentum.smart_money_early_count = # distinct
 * "smart set" wallets that bought this graduation in the 0-30s post-graduation
 * window. Called live at T+35 from detectBuyPressure (after competition_signals
 * for the window are populated). The smart-set definition is inlined here to
 * match getSmartSet() — keep the two in sync. Forward-only by construction: it
 * uses whatever wallets are "smart" at decision time, which is legitimately
 * knowable then; we never backfill historical rows (that would be look-ahead).
 */
export function updateSmartMoneyEarlyCount(db: Database.Database, graduationId: number): void {
  db.prepare(`
    UPDATE graduation_momentum
    SET smart_money_early_count = (
      SELECT COUNT(DISTINCT cs.wallet_address)
      FROM competition_signals cs
      JOIN wallet_scores ws ON ws.address = cs.wallet_address
      WHERE cs.graduation_id = @gid
        AND cs.action = 'buy'
        AND cs.seconds_since_graduation >= 0
        AND cs.seconds_since_graduation <= 30
        AND ws.total_realized_sol_drop_top3 > 0
        AND ws.monthly_run_rate_sol >= 3.75
        AND ws.total_realized_sol >= 0.5
    )
    WHERE graduation_id = @gid
  `).run({ gid: graduationId });
}

export function upsertFollow(
  db: Database.Database,
  row: { address: string; rank: number; copySizeSol: number; maxConcurrent: number; enabled: boolean; killCriterion: string; addedAt: number },
): void {
  db.prepare(`
    INSERT INTO follow_list (address, rank, copy_size_sol, max_concurrent, enabled, kill_criterion, added_at)
    VALUES (@address, @rank, @copy, @maxc, @enabled, @kill, @added)
    ON CONFLICT(address) DO UPDATE SET
      rank = excluded.rank,
      copy_size_sol = excluded.copy_size_sol,
      max_concurrent = excluded.max_concurrent,
      enabled = excluded.enabled,
      kill_criterion = excluded.kill_criterion
  `).run({
    address: row.address,
    rank: row.rank,
    copy: row.copySizeSol,
    maxc: row.maxConcurrent,
    enabled: row.enabled ? 1 : 0,
    kill: row.killCriterion,
    added: row.addedAt,
  });
}

/** Watchlist for the copy-follower probe: the promotable wallets in follow_list
 *  ("strict" set). Ordered by rank. */
export function getFollowListAddresses(db: Database.Database): string[] {
  return (db.prepare(`SELECT address FROM follow_list ORDER BY rank ASC`).all() as Array<{ address: string }>)
    .map((r) => r.address);
}

/** Money-edge smart-set addresses for the COPY WATCHLIST — same money gate as
 *  getSmartSet PLUS the copyability filter (getSmartSet itself stays unfiltered for
 *  the smart-money analysis). So we only subscribe to / copy wallets we can mirror. */
export function getSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    WHERE ws.total_realized_sol_drop_top3 > 0
      AND ws.monthly_run_rate_sol >= 3.75
      AND ws.total_realized_sol >= 0.5
      AND ${COPYABLE_SQL}
    ORDER BY ws.monthly_run_rate_sol DESC NULLS LAST
  `).all() as Array<{ address: string }>).map((r) => r.address);
}

/**
 * Discovery-method cohorts for the A/B (Idea 2 vs OG). Both apply the SAME
 * money-edge gate as getSmartSet — a wallet must be PROVEN smart to be in either
 * cohort. They partition the smart set by the co-trade signal:
 *   cotrade cohort = smart AND co-trades with >= COTRADE_COHORT_MIN_WINNERS
 *                    distinct proven winners (cotrade_candidates.n_distinct_winners)
 *   og cohort      = smart AND below that (incl. no co-trade row = 0)
 * Disjoint by construction (>= vs <). This tests whether smart wallets that
 * cluster with other proven winners outperform the smart wallets that don't —
 * a real, immediately-populated comparison (the old source-based split was always
 * empty because co-trade and the OG seed read the same competition_signals pool).
 * Tune the split with COTRADE_COHORT_MIN_WINNERS (env override).
 */
const COHORT_GATE =
  `ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5`;

export const COTRADE_COHORT_MIN_WINNERS = (() => {
  const v = parseInt(process.env.COTRADE_COHORT_MIN_WINNERS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5;
})();

export function getOgSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    LEFT JOIN cotrade_candidates cc ON cc.address = ws.address
    WHERE ${COHORT_GATE} AND COALESCE(cc.n_distinct_winners, 0) < @thr
      AND ${COPYABLE_SQL}
    ORDER BY ws.monthly_run_rate_sol DESC NULLS LAST
  `).all({ thr: COTRADE_COHORT_MIN_WINNERS }) as Array<{ address: string }>).map((r) => r.address);
}

export function getCotradeSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    JOIN cotrade_candidates cc ON cc.address = ws.address
    WHERE ${COHORT_GATE} AND cc.n_distinct_winners >= @thr
      AND ${COPYABLE_SQL}
    ORDER BY ws.monthly_run_rate_sol DESC NULLS LAST
  `).all({ thr: COTRADE_COHORT_MIN_WINNERS }) as Array<{ address: string }>).map((r) => r.address);
}

/**
 * DISCOVERY-SOURCE cohort for the OG-vs-Idea1 A/B: copyable smart wallets the
 * live-tape harvester surfaced (source='live_tape') — wallets the OG seed never
 * saw. The trader quarantines these to leadSource:'live_tape' strategies, so the
 * existing strategies keep trading OG-discovered wallets ONLY and the live-tape
 * wallets only show up on the dedicated new strategies. Clean PnL comparison.
 */
export function getLiveTapeSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    JOIN wallet_candidates wc ON wc.address = ws.address
    WHERE ${COHORT_GATE} AND wc.source = 'live_tape'
      AND ${COPYABLE_SQL}
    ORDER BY ws.monthly_run_rate_sol DESC NULLS LAST
  `).all() as Array<{ address: string }>).map((r) => r.address);
}

/** From a set of addresses (the wallets we actually copy: follow_list ∪ smart set),
 *  return those whose cached score is stale (last_refreshed < cutoff or never set),
 *  oldest first, capped at `limit`. Drives the worker's priority-refresh pass so the
 *  wallets we use stay fresh ahead of the never-scored backlog — getCandidates sorts
 *  never-scored first, so without this the promotable set goes days-stale and good
 *  wallets falsely age out of the active gate. */
export function getStaleAddresses(
  db: Database.Database,
  addresses: string[],
  cutoffTs: number,
  limit: number,
): string[] {
  if (addresses.length === 0 || limit <= 0) return [];
  const placeholders = addresses.map(() => '?').join(',');
  return (db.prepare(`
    SELECT address FROM wallet_candidates
    WHERE address IN (${placeholders}) AND (last_refreshed IS NULL OR last_refreshed < ?)
    ORDER BY (last_refreshed IS NULL) DESC, last_refreshed ASC
    LIMIT ?
  `).all(...addresses, cutoffTs, limit) as Array<{ address: string }>).map((r) => r.address);
}

// ── Live-tape harvester (Idea 1) ──────────────────────────────────────────────

export interface LiveTallyDelta {
  address: string;
  buys: number; sells: number;
  solIn: number; solOut: number;
  mints: string[];   // distinct non-WSOL mints seen this flush window (for cumulative tracking)
  firstSeen: number; lastSeen: number;
}

/** Batch-merge a flush window of in-memory tallies into live_wallet_tally,
 *  accumulating counts, and record each window's mints into live_wallet_mints so
 *  the distinct-mint count is CUMULATIVE across windows (read in the summary).
 *  Call per chunk — the harvester yields between chunks so a big flush can't block
 *  the event loop. */
export function mergeLiveTallies(db: Database.Database, deltas: LiveTallyDelta[], now: number): void {
  const tallyStmt = db.prepare(`
    INSERT INTO live_wallet_tally (address, buys, sells, sol_in, sol_out, distinct_mints, first_seen, last_seen, updated_at)
    VALUES (@address, @buys, @sells, @solIn, @solOut, 0, @firstSeen, @lastSeen, @now)
    ON CONFLICT(address) DO UPDATE SET
      buys = buys + excluded.buys,
      sells = sells + excluded.sells,
      sol_in = sol_in + excluded.sol_in,
      sol_out = sol_out + excluded.sol_out,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at
  `);
  const mintStmt = db.prepare(`INSERT OR IGNORE INTO live_wallet_mints (address, mint) VALUES (?, ?)`);
  const tx = db.transaction((rows: LiveTallyDelta[]) => {
    for (const d of rows) {
      tallyStmt.run({ ...d, now });
      for (const m of d.mints) mintStmt.run(d.address, m);
    }
  });
  tx(deltas);
}

/** Screen the tally for wallets worth the expensive scorer and promote them into
 *  wallet_candidates(source='live_tape'). The screen is ACTIVITY-based, not
 *  profit-based: under ~9% tape sampling the per-wallet rough net is dominated by
 *  unmatched sells (we catch a wallet's sells but not its buys), so it ranks "who
 *  we caught selling", not who's profitable. The screen's only job is "is this
 *  wallet active enough to be worth 301 RPC calls to FIFO-score?" — profitability
 *  is the scorer's job. Returns the number newly promoted. */
export function promoteLiveTapeWallets(
  db: Database.Database,
  opts: { minBuys: number; minSells: number; cap: number },
  now: number,
): number {
  const rows = db.prepare(`
    SELECT address FROM live_wallet_tally
    WHERE promoted = 0
      AND buys >= @minBuys AND sells >= @minSells
    ORDER BY (buys + sells) DESC
    LIMIT @cap
  `).all({ ...opts }) as Array<{ address: string }>;
  if (rows.length === 0) return 0;
  const mark = db.prepare(`UPDATE live_wallet_tally SET promoted = 1 WHERE address = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      upsertCandidate(db, r.address, 'live_tape', now);
      mark.run(r.address);
    }
  });
  tx();
  return rows.length;
}

/** Bound both tables: drop un-promoted, low-activity, stale rows + their mints. */
export function evictStaleLiveTallies(
  db: Database.Database,
  opts: { staleBefore: number; minActivity: number },
): number {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM live_wallet_mints WHERE address IN (
        SELECT address FROM live_wallet_tally
        WHERE promoted = 0 AND last_seen < @staleBefore AND (buys + sells) < @minActivity
      )
    `).run({ ...opts });
    return db.prepare(`
      DELETE FROM live_wallet_tally
      WHERE promoted = 0 AND last_seen < @staleBefore AND (buys + sells) < @minActivity
    `).run({ ...opts }).changes;
  });
  return tx() as number;
}

export interface LiveTapeSummary {
  total_wallets: number;
  promoted: number;
  scored: number;       // promoted wallets that have a wallet_scores row
  live_tape_smart: number; // promoted wallets passing the money-edge gate (genuinely-new tradeable alpha)
  // Most ACTIVE two-sided wallets (buys>0 AND sells>0 so unmatched-sell artifacts
  // are excluded). net_sol is a ROUGH gross figure under sampling — informational
  // only; the FIFO scorer is the real bar. distinct_mints is cumulative.
  top: Array<{ address: string; buys: number; sells: number; net_sol: number; distinct_mints: number; promoted: boolean }>;
}

export function getLiveTapeSummary(db: Database.Database): LiveTapeSummary {
  const empty: LiveTapeSummary = { total_wallets: 0, promoted: 0, scored: 0, live_tape_smart: 0, top: [] };
  try {
    const c = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN promoted=1 THEN 1 ELSE 0 END) AS promoted
      FROM live_wallet_tally
    `).get() as { total: number; promoted: number | null };
    empty.total_wallets = c.total ?? 0;
    empty.promoted = c.promoted ?? 0;

    const s = db.prepare(`
      SELECT COUNT(*) AS scored,
        SUM(CASE WHEN ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5 THEN 1 ELSE 0 END) AS smart
      FROM wallet_candidates wc
      JOIN wallet_scores ws ON ws.address = wc.address
      WHERE wc.source = 'live_tape'
    `).get() as { scored: number | null; smart: number | null };
    empty.scored = s.scored ?? 0;
    empty.live_tape_smart = s.smart ?? 0;

    // Two-sided wallets only (buys>0 AND sells>0), ranked by activity. distinct
    // mints from the cumulative side table.
    empty.top = (db.prepare(`
      SELECT t.address, t.buys, t.sells, (t.sol_out - t.sol_in) AS net_sol, t.promoted,
             (SELECT COUNT(*) FROM live_wallet_mints m WHERE m.address = t.address) AS distinct_mints
      FROM live_wallet_tally t
      WHERE t.buys > 0 AND t.sells > 0
      ORDER BY (t.buys + t.sells) DESC
      LIMIT 20
    `).all() as Array<Record<string, number>>).map((r) => ({
      address: r.address as unknown as string,
      buys: r.buys, sells: r.sells, net_sol: +(+r.net_sol).toFixed(3),
      distinct_mints: r.distinct_mints, promoted: !!r.promoted,
    }));
  } catch { /* table may not exist yet */ }
  return empty;
}

export interface ProbeEventInsert {
  wallet_address: string;
  signature: string;
  mint: string | null;
  action: string | null;
  sol_delta: number | null;
  venue: string | null;
  tier: string;              // 'promotable' | 'smart'
  their_block_time: number | null;
  detected_at: number;        // unix ms
  detection_lag_sec: number | null;
  decision_lag_ms: number | null;  // WS notification arrival → copy dispatch (our processing)
  total_lag_sec: number | null;    // lead block_time → copy dispatch (transport + decision)
  slot: number | null;
}

/** Record one detected smart-wallet swap (probe only — no position taken). */
export function insertProbeEvent(db: Database.Database, ev: ProbeEventInsert): void {
  db.prepare(`
    INSERT OR IGNORE INTO copy_probe_events
      (wallet_address, signature, mint, action, sol_delta, venue, tier, their_block_time, detected_at, detection_lag_sec, decision_lag_ms, total_lag_sec, slot)
    VALUES (@wallet_address, @signature, @mint, @action, @sol_delta, @venue, @tier, @their_block_time, @detected_at, @detection_lag_sec, @decision_lag_ms, @total_lag_sec, @slot)
  `).run(ev);
}

/**
 * Backfill the transport-derived lags once block_time is known. The fast WS-parse
 * path dispatches the copy BEFORE block_time is available (it isn't in the
 * processed-commitment push), so detection_lag_sec / total_lag_sec are filled in
 * here from a cheap async getBlockTime(slot). total = transport + the row's own
 * already-stored decision_lag_ms. Updates every wallet row sharing the signature.
 */
export function updateProbeEventLag(
  db: Database.Database,
  args: { signature: string; their_block_time: number; detection_lag_sec: number },
): void {
  db.prepare(`
    UPDATE copy_probe_events
    SET their_block_time = @their_block_time,
        detection_lag_sec = @detection_lag_sec,
        total_lag_sec = ROUND(@detection_lag_sec + COALESCE(decision_lag_ms, 0) / 1000.0, 2)
    WHERE signature = @signature
  `).run(args);
}
