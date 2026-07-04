import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { seedCandidatesFromDb, recomputeCandidatePriorities } from './discovery';
import {
  getCandidates,
  cacheWalletSwaps,
  getCachedSwaps,
  trimWalletCache,
  replaceRoundTrips,
  upsertWalletScore,
  getTopWalletScores,
  getDeepRescanCandidates,
  upsertFollow,
  getFollowListAddresses,
  getSmartSetAddresses,
  getStaleAddresses,
} from './queries';
import { fetchWalletSwaps, scoreWallet, reconstructRoundTrips, WalletSwap } from './wallet-pnl';
import { rankWallets } from './ranker';
import { computeAndCacheSmartMoney } from './smart-money';
import { computeCotradeDiscovery } from './cotrade-discovery';
import { seedExternalCandidates } from './external-seed';
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
  // 2026-07-03: CRANKED batch 50 → 200 to spend an added ~5M-credit budget on the scoring backlog.
  // 2026-07-04: REVERTED (200 → 75, deep 8 → 3) under the Jul 4→22 15M-credit cap. wallet_pnl was
  // ~19%+ of the Helius bill and the +5M budget that justified the crank is gone; backlog-clearing
  // is research, not live-critical, so it yields the budget first. ~75 wallets × ~300 parsed txs ×
  // 6 ticks/day ≈ up to ~135k req/day (self-limits — most wallets have far fewer txs). Scoring is
  // droppable-tier so copy polls still preempt. Tune via COPYTRADE_* envs (raise after Jul 22).
  intervalMs: 4 * 60 * 60 * 1000, // 4h between scoring passes
  firstRunDelayMs: 90 * 1000,     // let boot/first-sync settle before RPC work
  scoreBatchLimit: 75,            // backlog FIRST-scans per tick (reverted 2026-07-04 for the 15M cap)
  maxSignaturesPerWallet: 300,    // shallow first-scan / triage depth
  maxSignaturesDeep: 1500,        // DEEP-rescan depth for promising-but-n-capped wallets
  cacheMaxSwaps: 1500,            // incremental-cache cap = deepest history we score on
  deepBatchLimit: 3,             // deep rescans per tick (reverted 2026-07-04 with the batch revert)
  restaleSeconds: 24 * 3600,      // re-score a BACKLOG wallet at most once / 24h
  // Priority-refresh: keep the wallets we actually copy (follow_list ∪ smart set)
  // fresh on a TIGHT cadence. Refreshes are now INCREMENTAL (fetch only sigs newer
  // than the cache → ~10x cheaper than a full re-scan), so this is decoupled from
  // scoreBatchLimit and the batch is bumped up — the backlog keeps its full budget.
  refreshSeconds: 6 * 3600,       // re-score a USED wallet at most once / 6h
  refreshBatchLimit: 30,          // used-wallets refreshed per tick (incremental, cheap)
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
  private readonly maxSignaturesDeep: number;
  private readonly cacheMaxSwaps: number;
  private readonly deepBatchLimit: number;
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
    this.maxSignaturesDeep = intEnv('COPYTRADE_MAX_SIGS_DEEP', DEFAULTS.maxSignaturesDeep);
    this.cacheMaxSwaps = intEnv('COPYTRADE_CACHE_MAX_SWAPS', DEFAULTS.cacheMaxSwaps);
    this.deepBatchLimit = intEnv('COPYTRADE_DEEP_BATCH', DEFAULTS.deepBatchLimit);
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

    // Co-trade discovery (Idea 2) — pure DB, no RPC. Populates cotrade_candidates
    // from wallets that buy alongside proven smart wallets, so the cotrade A/B
    // cohort is visible on deploy and the priority boost routes scoring to them.
    try { computeCotradeDiscovery(this.db); }
    catch (err) { logger.warn('Initial co-trade discovery failed: %s', err instanceof Error ? err.message : String(err)); }

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

  /** Score a single wallet. INCREMENTAL by default: load the cached swaps, fetch
   *  only signatures newer than the newest cached one, merge, and score the union —
   *  a refresh costs ~(new sigs) calls instead of a full ~300-call re-scan, and the
   *  cache deepens over time. `deep` forces a one-shot full backward scan to
   *  maxSignaturesDeep (rescues promising wallets the 300-sig depth rejected on n).
   *  A first scan (empty cache) is a shallow backward scan to maxSignatures.
   *  Returns true on success. Shared by the refresh / backlog / deep passes. */
  private async scoreOne(
    connection: Connection, address: string, now: number, opts: { deep?: boolean } = {},
  ): Promise<boolean> {
    const deep = opts.deep ?? false;
    try {
      const cached = getCachedSwaps(this.db, address);
      let fetched: WalletSwap[];
      if (cached.length > 0 && !deep) {
        // Incremental — only sigs newer than the newest cached swap.
        const newestSig = cached[cached.length - 1].signature;
        fetched = await fetchWalletSwaps(connection, address, { maxSignatures: this.maxSignaturesDeep, until: newestSig });
      } else {
        // First scan (shallow) or deep rescan (full backward to the deep depth).
        const depth = deep ? this.maxSignaturesDeep : this.maxSignatures;
        fetched = await fetchWalletSwaps(connection, address, { maxSignatures: depth });
      }

      // Merge cached + fetched, dedup by signature, keep the newest cacheMaxSwaps.
      const bySig = new Map<string, WalletSwap>();
      for (const s of cached) bySig.set(s.signature, s);
      for (const s of fetched) bySig.set(s.signature, s);
      let union = [...bySig.values()].sort((a, b) => a.blockTime - b.blockTime);
      if (union.length > this.cacheMaxSwaps) union = union.slice(union.length - this.cacheMaxSwaps);

      cacheWalletSwaps(this.db, address, fetched);      // OR IGNORE adds the new rows
      trimWalletCache(this.db, address, this.cacheMaxSwaps);
      const score = scoreWallet(address, union);
      replaceRoundTrips(this.db, address, reconstructRoundTrips(union));
      // Record scan depth only for backward scans (deep / first); an incremental
      // refresh passes null so it never downgrades a prior deep depth.
      const scanSigs = deep ? this.maxSignaturesDeep : (cached.length === 0 ? this.maxSignatures : null);
      upsertWalletScore(this.db, score, now, scanSigs);
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
      // Refresh co-trade discovery BEFORE priority recompute so cotrade candidates
      // get their priority boost this tick (the scorer then reaches them fast).
      computeCotradeDiscovery(this.db, now);
      // External top-trader seed (Idea 3) — plain HTTPS to Solana Tracker, no RPC
      // cost. No-ops without SOLANATRACKER_API_KEY. Before priority recompute so
      // the fetched wallets get their boost and are scored this tick.
      try { await seedExternalCandidates(this.db, now); }
      catch (err) { logger.warn('External seed failed: %s', err instanceof Error ? err.message : String(err)); }
      // Rank candidates by in-DB signal so we score likely-alpha wallets first.
      recomputeCandidatePriorities(this.db);

      // 1) PRIORITY REFRESH: re-score the wallets we actually copy (follow_list ∪
      //    smart set) that have gone stale, BEFORE the backlog. These are now
      //    INCREMENTAL (cheap), so the batch is decoupled from the backlog budget —
      //    the backlog keeps its full scoreBatchLimit.
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

      // 2) BACKLOG DISCOVERY — full scoreBatchLimit. getCandidates sorts by priority,
      //    and screened promoted wallets (live_tape +1000, cotrade) now outrank the
      //    random OG backlog, so they get scored FIRST. Runs BEFORE the deep rescan
      //    so deep scans (1500 sigs each) can't starve the wallets we want scored.
      const staleBefore = now - this.restaleSeconds;
      const candidates = getCandidates(this.db, { staleBeforeTs: staleBefore, limit: this.scoreBatchLimit });
      let scored = 0;
      for (const c of candidates) {
        if (await this.scoreOne(connection, c.address, now)) scored++;
      }

      // 3) DEEP RESCAN (last): rescue promising-but-n-capped wallets (positive
      //    realized, 40-99 round trips, only shallow-scanned) with a one-shot deep
      //    backward scan, so the 300-sig depth artifact stops rejecting genuine
      //    elites. Runs LAST so its 1500-sig scans take leftover budget, not the
      //    budget that should score the promoted backlog.
      const deepList = getDeepRescanCandidates(this.db, {
        minTotalSol: 0.2, nLow: 40, nHigh: 100, deepSigs: this.maxSignaturesDeep, limit: this.deepBatchLimit,
      });
      let deepScored = 0;
      for (const addr of deepList) {
        if (await this.scoreOne(connection, addr, now, { deep: true })) deepScored++;
      }
      logger.info('Refreshed %d used (incremental); scored %d backlog; deep-rescanned %d',
        refreshed, candidates.length, deepScored);

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
