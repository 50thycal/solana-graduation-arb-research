import Database from 'better-sqlite3';
import { upsertCandidate, getFollowListAddresses, getSmartSetAddresses } from './queries';
import { getCopyNetSelectedAddresses } from './leaderboard-v2';
import { enrollPrefilterWallet, countPrefilterWatchingByOrigin } from './winner-prefilter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('gradspec-harvester');

/**
 * GRADSPEC harvester (discovery source 'gradspec', 2026-07-05 phase-1 handoff) — reseed
 * the winner-sniper forward pre-filter from the POST-GRAD-AMM SPECIALIST archetype.
 *
 * THE THESIS: wallets that repeatedly trade fresh post-graduation PumpSwap pools
 * profitably are skilled early buyers living in the 30s-15min post-grad window — not on
 * public leaderboards (the crowded/decayed `external` set) and not the 0-30s snipers the
 * OG seed reads. The `smart-money → timing` panel isolates them: high `grad_buys`, low
 * `pre_pct` (archetype `post_grad_amm`). This attacks the reachability wall that keeps
 * every non-OG source at n≈0: the winner-sniper stage-1 seed (0-30s buyers of labeled
 * winners) is too narrow (~3 wallets reach the pre-filter); the archetype seed enrolls
 * wallets that BY CONSTRUCTION trade the fast copyable universe.
 *
 * THE ONE LEVER: only the seeding heuristic is new. Everything downstream is reused —
 * bar-clearing wallets enroll into the EXISTING winner-prefilter forward gate
 * (origin='gradspec'; ≥2 profitable CLOSED positions on non-trigger mints, net ≥ 0.25
 * SOL, 120h TTL, out-of-sample by construction since flows only accumulate after
 * enrollment) → pass promotes to the FIFO scorer → the relaxed source gate decides
 * tradability (discovery-sources.ts signalSet, origin-scoped) → the standardized
 * `copy-src-gradspec` probe vs the OG control. Read the verdict on
 * `copy-trades.json → discovery_scorecard`.
 *
 * POINT-IN-TIME construction: the archetype (`grad_buys`, `pre_pct`, recency) is
 * historical and knowable at enrollment; tradability is the FORWARD pre-filter. No
 * field resolves after entry — nothing here needs to know how a token ended up.
 *
 * COST: the archetype query is pure SQL over wallet_tx_cache ⋈ graduations (zero RPC).
 * The pre-filter's own transactionSubscribe is zero-RPC (WS-billed, bounded by the
 * shared PREFILTER_MAX_WALLETS cap + the per-origin sub-cap below so gradspec can't
 * starve winner-sniper's slots). Passers add wallet_pnl scoring + watchlist WS — the
 * real cost, bounded by COPYSRC_WATCH_CAP.
 */

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

export const GRADSPEC_CFG = {
  /** Archetype bar: at least this many buy events on tracked graduation mints. */
  minGradBuys: numEnv('GRADSPEC_MIN_GRAD_BUYS', 50),
  /** ...with at most this fraction of them pre-graduation (bonding-curve snipers excluded). */
  maxPrePct: numEnv('GRADSPEC_MAX_PRE_PCT', 0.10),
  /** ...and a graduation buy within this many days (dormant specialists are useless). */
  activeDays: numEnv('GRADSPEC_ACTIVE_DAYS', 14),
  /** Max wallets enrolled into the pre-filter per harvest pass. */
  enrollCap: numEnv('GRADSPEC_ENROLL_CAP', 25),
  /** Per-origin sub-cap on WATCHING pre-filter slots (the 200-slot pool is shared with winner-sniper). */
  maxWatching: numEnv('GRADSPEC_MAX_WATCHING', 75),
};

/**
 * One harvest pass: find archetype wallets and enroll the best of them into the forward
 * pre-filter. Pure SQL, zero RPC — wired into the CopytradeWorker tick. Returns the
 * number of wallets newly enrolled.
 *
 * The seed reads wallet_tx_cache (scored wallets' swap history — the same surface the
 * smart-money timing panel derives the archetype from). That bounds the seed to wallets
 * the scorer has already seen, which is the point: their per-grad behavior is on record,
 * and the pre-filter re-proves the edge forward before any of them costs a probe trade.
 */
export function harvestGradspecCandidates(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
): number {
  // Respect the per-origin sub-cap before doing any work.
  const watching = countPrefilterWatchingByOrigin(db, 'gradspec');
  const room = Math.min(GRADSPEC_CFG.enrollCap, GRADSPEC_CFG.maxWatching - watching);
  if (room <= 0) return 0;

  let rows: Array<{ addr: string; grad_buys: number; pre_pct: number }> = [];
  try {
    rows = db.prepare(`
      SELECT w.address AS addr,
             COUNT(*) AS grad_buys,
             SUM(CASE WHEN w.venue = 'pumpfun_bc'
                        OR (w.block_time IS NOT NULL AND w.block_time < g.timestamp)
                      THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS pre_pct
      FROM wallet_tx_cache w
      JOIN graduations g ON g.mint = w.mint
      WHERE w.action = 'buy'
      GROUP BY w.address
      HAVING COUNT(*) >= @minBuys
         AND pre_pct <= @maxPrePct
         AND MAX(w.block_time) >= @activeCutoff
      ORDER BY grad_buys DESC
    `).all({
      minBuys: GRADSPEC_CFG.minGradBuys,
      maxPrePct: GRADSPEC_CFG.maxPrePct,
      activeCutoff: now - GRADSPEC_CFG.activeDays * 86_400,
    }) as typeof rows;
  } catch (err) {
    logger.warn('archetype query failed: %s', err instanceof Error ? err.message : String(err));
    return 0;
  }
  if (rows.length === 0) return 0;

  // Skip wallets the OG book already trades — enrolling them would burn shared
  // pre-filter slots on wallets the signal set subtracts anyway (quarantine: gradspec
  // may only claim wallets no other book is trading).
  const ogUniverse = new Set<string>();
  try { for (const a of getFollowListAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }
  try { for (const a of getSmartSetAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }
  try { for (const a of getCopyNetSelectedAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }

  let enrolled = 0;
  for (const r of rows) {
    if (enrolled >= room) break;
    if (ogUniverse.has(r.addr)) continue;
    // Behavioral seed → no trigger mint: every forward flow counts toward the bar.
    const res = enrollPrefilterWallet(db, r.addr, null, now, 'gradspec');
    if (res === 'full') break; // shared pool exhausted — try again next tick
    if (res !== 'enrolled') continue; // already watching/resolved (any origin)
    upsertCandidate(db, r.addr, 'gradspec', now); // no-op for already-known candidates (ON CONFLICT DO NOTHING)
    enrolled++;
  }
  if (enrolled > 0) {
    logger.info('GRADSPEC harvest: enrolled %d archetype wallets into the pre-filter (%d matched the bar, %d watching before)',
      enrolled, rows.length, watching);
  }
  return enrolled;
}
