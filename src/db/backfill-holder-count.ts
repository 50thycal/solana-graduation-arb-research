/**
 * src/db/backfill-holder-count.ts
 *
 * One-shot, idempotent backfill that re-resolves holder_count (and the
 * concentration fields top5/top10/dev/gini) for historical graduation_momentum
 * rows using the Helius DAS getTokenAccounts path in HolderEnrichment.
 *
 * WHY: rows enriched before the DAS upgrade frequently have holder_count pinned
 * at the getTokenLargestAccounts cap (~19) because the old getProgramAccounts
 * STEP 2 was blocked by the RPC provider. A handful also have 0 concentration
 * from instant-graduation timing. This re-runs full enrichment to replace them.
 *
 * MARKER TRI-STATE (holder_count_backfilled):
 *   0    = measured at graduation by the live enricher (trustworthy, the only
 *          bucket safe to build strategy on).
 *   1    = re-resolved post-hoc by this backfill (as-of-now, survivorship-biased).
 *   NULL = legacy row enriched before the marker existed. Untrustworthy (old
 *          ~19-cap logic, unknown timing) so this backfill claims it and stamps
 *          it 1 — legacy is treated as backfill, never as measured.
 * The live enricher stamps 0 the instant it writes, so a measured row is never
 * NULL and this backfill (NULL-only) can never reclaim and overwrite it.
 *
 * TEMPORAL CAVEAT (important): DAS getTokenAccounts returns holders AS OF NOW,
 * not as of the token's graduation. For old rows "holders now" has drifted from
 * "holders at T+30". So every row this backfill touches is stamped
 * holder_count_backfilled = 1, letting analysis include/exclude these
 * current-state values the same way the look-ahead guardrail excludes _t300
 * columns. token_age_seconds, creator_wallet_address and dev_wallet_address are
 * graduation-time invariants (derived from the bonding curve's creation tx), so
 * re-resolving them is strictly an improvement.
 *
 * IDEMPOTENCY: targets only rows where holder_count_backfilled IS NULL, so once
 * a row is stamped it's never touched again — safe to invoke on every boot. A
 * GRACE_SECONDS window excludes very recent rows so we never clobber a row the
 * live enricher just wrote correctly at graduation time (those keep marker NULL
 * = trustworthy graduation-time state and stay authoritative).
 */

import type Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { HolderEnrichment } from '../collector/holder-enrichment';
import {
  updateMomentumEnrichment,
  updateGraduationEnrichment,
  computeCreatorReputation,
  updateMomentumReputation,
} from './queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('backfill-holder-count');

// Don't touch rows younger than this — the live enricher owns them and its
// at-graduation read is more accurate than a current-state re-resolve.
const GRACE_SECONDS = 2 * 60 * 60; // 2 hours
// Throttle between rows so the backfill trickles behind live enrichment and
// never starves the RPC limiter. Matches the existing wallet/velocity backfills.
const ROW_DELAY_MS = 250;

let running = false;

export function holderBackfillRunning(): boolean {
  return running;
}

/** Count of rows still awaiting a holder-count backfill (for /status endpoints). */
export function holderBackfillPending(db: Database.Database): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM graduation_momentum
     WHERE holder_count_backfilled IS NULL
       AND created_at < (unixepoch() - ?)`
  ).get(GRACE_SECONDS) as any).n;
}

interface BackfillCandidate {
  graduation_id: number;
  mint: string;
  bonding_curve_address: string | null;
  grad_timestamp: number | null;
}

/**
 * Kick off the holder-count backfill in the background. Returns immediately with
 * how many rows were queued; the actual RPC work runs detached. No-ops (returns
 * { started: false }) if a run is already in progress or there's nothing to do.
 */
export function startHolderCountBackfill(
  db: Database.Database,
  rpcUrl: string
): { started: boolean; queued: number } {
  if (running) {
    return { started: false, queued: 0 };
  }

  const candidates = db.prepare(`
    SELECT gm.graduation_id, g.mint, g.bonding_curve_address,
           g.timestamp AS grad_timestamp
    FROM graduation_momentum gm
    JOIN graduations g ON g.id = gm.graduation_id
    WHERE gm.holder_count_backfilled IS NULL
      AND gm.created_at < (unixepoch() - @grace)
    ORDER BY g.timestamp ASC
  `).all({ grace: GRACE_SECONDS }) as BackfillCandidate[];

  if (candidates.length === 0) {
    logger.info('Holder-count backfill: nothing to do (all historical rows already stamped)');
    return { started: false, queued: 0 };
  }

  running = true;
  logger.info({ queued: candidates.length }, 'Holder-count backfill starting in background');

  const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
  const enricher = new HolderEnrichment(conn);

  let upgraded = 0;
  let unchanged = 0;
  let failed = 0;

  (async () => {
    for (const row of candidates) {
      try {
        const enrichment = await enricher.enrich(
          row.mint,
          row.bonding_curve_address ?? '',
          row.grad_timestamp ?? undefined
        );

        // Guard: never overwrite a real historical count with 0. A 0 here means
        // both DAS and the getProgramAccounts fallback came up empty (dead pool,
        // RPC hiccup). Leave the row unstamped so a later boot retries it.
        if (enrichment.holderCount > 0) {
          updateMomentumEnrichment(db, row.graduation_id, {
            holder_count: enrichment.holderCount,
            top5_wallet_pct: enrichment.top5WalletPct,
            top10_wallet_pct: enrichment.top10WalletPct,
            wallet_gini_top20: enrichment.walletGiniTop20,
            dev_wallet_pct: enrichment.devWalletPct,
            token_age_seconds: enrichment.tokenAgeSeconds,
            dev_wallet_address: enrichment.devWalletAddress,
            creator_wallet_address: enrichment.creatorWalletAddress,
            holder_count_backfilled: 1,
          });
          updateGraduationEnrichment(db, row.graduation_id, {
            holder_count: enrichment.holderCount,
            top5_wallet_pct: enrichment.top5WalletPct,
            dev_wallet_pct: enrichment.devWalletPct,
            token_age_seconds: enrichment.tokenAgeSeconds,
            dev_wallet_address: enrichment.devWalletAddress,
            creator_wallet_address: enrichment.creatorWalletAddress,
          });

          // Recompute creator reputation if we (re)resolved the creator wallet —
          // mirrors the live enrichment path so wallet-rep filters stay populated.
          if (enrichment.creatorWalletAddress && row.grad_timestamp) {
            try {
              const rep = computeCreatorReputation(db, enrichment.creatorWalletAddress, row.grad_timestamp);
              updateMomentumReputation(db, row.graduation_id, rep);
            } catch (repErr) {
              logger.debug('Holder backfill: reputation recompute failed for grad %d: %s',
                row.graduation_id, repErr instanceof Error ? repErr.message : String(repErr));
            }
          }
          upgraded++;
        } else {
          unchanged++;
        }
      } catch (err) {
        failed++;
        logger.debug('Holder backfill failed for grad %d: %s',
          row.graduation_id, err instanceof Error ? err.message : String(err));
      }

      await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
    }

    running = false;
    logger.info(
      { upgraded, unchanged, failed, total: candidates.length },
      'Holder-count backfill complete'
    );
  })().catch((err) => {
    running = false;
    logger.error('Holder-count backfill crashed: %s', err instanceof Error ? err.message : String(err));
  });

  return { started: true, queued: candidates.length };
}
