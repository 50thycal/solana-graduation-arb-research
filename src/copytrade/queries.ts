import Database from 'better-sqlite3';
import type { WalletScore, WalletSwap, RoundTrip } from './wallet-pnl';

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
): void {
  db.prepare(`
    INSERT INTO wallet_scores (
      address, n_round_trips, total_realized_sol, total_realized_sol_drop_top3,
      median_rt_pct, monthly_run_rate_sol, win_rate, avg_hold_sec, last_active,
      venues_json, scored_at
    ) VALUES (
      @address, @n, @total, @drop3, @median, @monthly, @win, @hold, @last_active,
      @venues, @scored_at
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
      scored_at = excluded.scored_at
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
  });
  db.prepare(`UPDATE wallet_candidates SET last_refreshed = ? WHERE address = ?`)
    .run(scoredAt, score.address);
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

/** Money-edge smart-set addresses (broader tier) — same filter as getSmartSet. */
export function getSmartSetAddresses(db: Database.Database): string[] {
  return getSmartSet(db).map((r) => r.address);
}

/**
 * Discovery-method cohorts for the A/B (Idea 2 vs OG). Both apply the SAME
 * money-edge gate as getSmartSet — they differ ONLY by how the wallet was
 * discovered, read from wallet_candidates.source. The two are DISJOINT by
 * construction: source='cotrade_graph' sticks only when the OG seed never saw the
 * wallet (OG seeding uses ON CONFLICT DO NOTHING), so a wallet is in exactly one
 * cohort. This is what lets a cotrade-only strategy be compared cleanly against an
 * og_smart-only strategy with identical params.
 */
const COHORT_GATE =
  `ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5`;

export function getOgSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    JOIN wallet_candidates wc ON wc.address = ws.address
    WHERE ${COHORT_GATE} AND COALESCE(wc.source, '') != 'cotrade_graph'
    ORDER BY ws.monthly_run_rate_sol DESC NULLS LAST
  `).all() as Array<{ address: string }>).map((r) => r.address);
}

export function getCotradeSmartSetAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT ws.address FROM wallet_scores ws
    JOIN wallet_candidates wc ON wc.address = ws.address
    WHERE ${COHORT_GATE} AND wc.source = 'cotrade_graph'
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
