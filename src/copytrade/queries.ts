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
    return db.prepare(`
      SELECT * FROM wallet_candidates
      WHERE last_refreshed IS NULL OR last_refreshed < @stale
      ORDER BY (last_refreshed IS NOT NULL), last_refreshed ASC
      LIMIT @limit
    `).all({ stale: opts.staleBeforeTs, limit }) as WalletCandidate[];
  }
  return db.prepare(`SELECT * FROM wallet_candidates ORDER BY first_seen ASC LIMIT @limit`)
    .all({ limit }) as WalletCandidate[];
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
