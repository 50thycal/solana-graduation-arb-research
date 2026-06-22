import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { seedCandidatesFromDb, recomputeCandidatePriorities } from './discovery';
import {
  getCandidates,
  cacheWalletSwaps,
  replaceRoundTrips,
  upsertWalletScore,
  getTopWalletScores,
  upsertFollow,
  getFollowListAddresses,
  getSmartSetAddresses,
  getStaleAddresses,
} from './queries';
import { fetchWalletSwaps, scoreWallet, reconstructRoundTrips } from './wallet-pnl';
import { rankWallets } from './ranker';
import { computeAndCacheSmartMoney } from './smart-money';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copytrade-worker');

/**
 * Background wallet-intelligence worker (copy-trade Option B, Phase 1).
 *
 * Default-ON — no env var required to enable it; set COPYTRADE_DISABLED=true to
 * turn it off. It is deliberately conservative so it never starves the
 * graduation pipeline:
 *   - seeding is free (pure SQL over existing tables);
 *   - scoring fetches are gated by globalRpcLimiter inside fetchWalletSwaps,
 *     which DROPS wallet reads when the RPC queue is busy — graduation work
 *     always wins the token;
 *   - only a small batch of STALE candidates is scored per tick, on a slow
 *     interval, so the shared 10M-credit/month Helius cap is respected.
 *
 * Results land in wallet_scores; the gist-sync cycle reads them (no RPC) to
 * publish wallet-leaderboard.json. The worker never trades — Phase 1 is
 * research only.
 */

const DEFAULTS = {
  // 2026-06-17: graduation collection is OFF (detect-only), so the RPC budget is
  // copy's alone. Wallet discovery is now THE limiter on "not missing a smart
  // wallet" — only 2.5k of ~71k seeded candidates have been scored, and a wallet
  // can't enter the probe watchlist until it's scored + passes the smart-set gate.
  // Raised throughput 3x vs the 2026-06-11 budget cut (15/6h/250 → 30/4h/300):
  // ~30 wallets × ~300 parsed txs × 6 ticks/day ≈ 54k req/day, leaving the rest
  // of the ~250k/day copy budget for position polling. Tune via COPYTRADE_* envs.
  intervalMs: 4 * 60 * 60 * 1000, // 4h between scoring passes (was 6h)
  firstRunDelayMs: 90 * 1000,     // let boot/first-sync settle before RPC work
  scoreBatchLimit: 30,            // total wallets scored per tick (was 15)
  maxSignaturesPerWallet: 300,    // history depth per wallet (was 250)
  restaleSeconds: 24 * 3600,      // re-score a BACKLOG wallet at most once / 24h
  // Priority-refresh: keep the wallets we actually copy (follow_list ∪ smart set)
  // fresh on a TIGHT cadence, ahead of the never-scored backlog. Without this the
  // promotable set goes days-stale (the 24h activity column reads 0 for everyone and
  // good wallets falsely age out of the active≤14d gate). RPC-neutral — the refresh
  // batch is taken OUT of scoreBatchLimit, not added on top.
  refreshSeconds: 6 * 3600,       // re-score a USED wallet at most once / 6h
  refreshBatchLimit: 12,          // max used-wallets refreshed per tick (of scoreBatchLimit)
};

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class CopytradeWorker {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private readonly intervalMs: number;
  private readonly scoreBatchLimit: number;
  private readonly maxSignatures: number;
  private readonly restaleSeconds: number;
  private readonly refreshSeconds: number;
  private readonly refreshBatchLimit: number;
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
    this.intervalMs = intEnv('COPYTRADE_INTERVAL_MS', DEFAULTS.intervalMs);
    this.scoreBatchLimit = intEnv('COPYTRADE_SCORE_BATCH', DEFAULTS.scoreBatchLimit);
    this.maxSignatures = intEnv('COPYTRADE_MAX_SIGS', DEFAULTS.maxSignaturesPerWallet);
    this.restaleSeconds = intEnv('COPYTRADE_RESTALE_SEC', DEFAULTS.restaleSeconds);
    this.refreshSeconds = intEnv('COPYTRADE_REFRESH_SEC', DEFAULTS.refreshSeconds);
    this.refreshBatchLimit = intEnv('COPYTRADE_REFRESH_BATCH', DEFAULTS.refreshBatchLimit);
  }

  start(): void {
    if (process.env.COPYTRADE_DISABLED === 'true') {
      logger.info('CopytradeWorker disabled via COPYTRADE_DISABLED=true');
      return;
    }

    // Seed immediately — pure SQL, zero RPC, makes the candidate pool visible
    // on the very first sync even before any scoring has run.
    try {
      const added = seedCandidatesFromDb(this.db);
      logger.info('Initial candidate seed: +%d new', added);
    } catch (err) {
      logger.warn('Initial seed failed: %s', err instanceof Error ? err.message : String(err));
    }

    // Compute the smart-money analysis now (pure DB, no RPC) so /smart-money +
    // smart-money.json are populated within seconds of deploy from existing
    // wallet_scores, rather than waiting for the first scoring tick.
    computeAndCacheSmartMoney(this.db);

    this.firstRunTimer = setTimeout(() => {
      this.runOnce().catch((err) => logger.error({ err }, 'CopytradeWorker first run failed'));
      this.interval = setInterval(() => {
        this.runOnce().catch((err) => logger.error({ err }, 'CopytradeWorker run failed'));
      }, this.intervalMs);
    }, DEFAULTS.firstRunDelayMs);

    logger.info(
      'CopytradeWorker started (intervalMs=%d, batch=%d, maxSigs=%d)',
      this.intervalMs, this.scoreBatchLimit, this.maxSignatures,
    );
  }

  stop(): void {
    if (this.firstRunTimer) { clearTimeout(this.firstRunTimer); this.firstRunTimer = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Score a single wallet: fetch swaps → cache → score → store round-trips →
   *  upsert (which stamps wallet_candidates.last_refreshed). Returns true on success.
   *  Shared by the priority-refresh and backlog passes. */
  private async scoreOne(connection: Connection, address: string, now: number): Promise<boolean> {
    try {
      const swaps = await fetchWalletSwaps(connection, address, { maxSignatures: this.maxSignatures });
      cacheWalletSwaps(this.db, address, swaps);
      const score = scoreWallet(address, swaps);
      replaceRoundTrips(this.db, address, reconstructRoundTrips(swaps));
      upsertWalletScore(this.db, score, now);
      return true;
    } catch (err) {
      logger.warn('Scoring %s failed: %s', address.slice(0, 8), err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** One seed + score-batch + rank pass. Guarded against overlap. */
  async runOnce(): Promise<void> {
    if (this.running) {
      logger.warn('CopytradeWorker run already in progress — skipping tick');
      return;
    }
    const connection = this.getConnection();
    if (!connection) {
      logger.warn('No live RPC connection — skipping scoring tick');
      return;
    }
    this.running = true;
    const now = Math.floor(Date.now() / 1000);
    try {
      seedCandidatesFromDb(this.db, now);
      // Rank candidates by in-DB signal so we score likely-alpha wallets first.
      recomputeCandidatePriorities(this.db);

      // 1) PRIORITY REFRESH: re-score the wallets we actually copy (follow_list ∪
      //    smart set) that have gone stale, BEFORE the backlog. getCandidates sorts
      //    never-scored wallets first, so without this the promotable set never gets
      //    refreshed and its activity/freshness data rots. Budget comes out of
      //    scoreBatchLimit (RPC-neutral), so the backlog gets whatever's left.
      const used = Array.from(new Set([
        ...getFollowListAddresses(this.db),
        ...getSmartSetAddresses(this.db),
      ]));
      const refreshList = getStaleAddresses(
        this.db, used, now - this.refreshSeconds, this.refreshBatchLimit,
      );
      let refreshed = 0;
      for (const addr of refreshList) {
        if (await this.scoreOne(connection, addr, now)) refreshed++;
      }

      // 2) BACKLOG DISCOVERY with the remaining budget (total ≈ scoreBatchLimit).
      const backlogBudget = Math.max(0, this.scoreBatchLimit - refreshed);
      const staleBefore = now - this.restaleSeconds;
      const candidates = backlogBudget > 0
        ? getCandidates(this.db, { staleBeforeTs: staleBefore, limit: backlogBudget })
        : [];
      logger.info('Refreshed %d used wallets; scoring %d backlog candidates', refreshed, candidates.length);

      let scored = 0;
      for (const c of candidates) {
        if (await this.scoreOne(connection, c.address, now)) scored++;
      }

      // Re-rank the full scored set and record promotable wallets to follow_list
      // (DISABLED — Phase 2 shadow validation is what flips enabled=1).
      try {
        const top = getTopWalletScores(this.db, 100).map((r) => ({
          address: r.address,
          nRoundTrips: r.n_round_trips,
          totalRealizedSol: r.total_realized_sol,
          totalRealizedSolDropTop3: r.total_realized_sol_drop_top3,
          medianRtPct: r.median_rt_pct,
          monthlyRunRateSol: r.monthly_run_rate_sol,
          winRate: r.win_rate,
          avgHoldSec: r.avg_hold_sec,
          lastActive: r.last_active,
          venues: r.venues_json ? JSON.parse(r.venues_json) : {},
        }));
        const ranked = rankWallets(top, now);
        let rank = 0;
        for (const rw of ranked) {
          if (!rw.passed) break;
          rank++;
          upsertFollow(this.db, {
            address: rw.score.address,
            rank,
            copySizeSol: 0.05,
            maxConcurrent: 1,
            enabled: false,
            killCriterion: 'n>=50 and net_sol<-1',
            addedAt: now,
          });
        }
        logger.info('Scoring tick complete: scored=%d, promotable=%d', scored, rank);
      } catch (err) {
        logger.warn('Ranking pass failed: %s', err instanceof Error ? err.message : String(err));
      }

      // Refresh the smart-money token-selection analysis now that wallet_scores
      // changed. Pure DB; cached for gist-sync + the /smart-money page.
      computeAndCacheSmartMoney(this.db);
    } finally {
      this.running = false;
    }
  }
}
