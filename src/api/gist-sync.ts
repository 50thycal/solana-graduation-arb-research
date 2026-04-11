/**
 * src/api/gist-sync.ts
 *
 * Pushes diagnose.json, snapshot.json, best-combos.json, and trades.json to
 * a dedicated `bot-status` branch every SYNC_INTERVAL_MS so Claude can
 * self-serve via WebFetch (raw.githubusercontent.com is reachable; Railway's
 * edge and gist.githubusercontent.com are not).
 *
 * Uses the low-level GitHub Git Tree API + force-push so the branch always
 * has exactly ONE commit — no history accumulates regardless of sync frequency.
 *
 * Required env var: GITHUB_TOKEN — classic token with `public_repo` scope,
 *   or fine-grained token with Contents:Write permission.
 * Optional env var: GIST_SYNC_INTERVAL_MS — defaults to 120000 (2 min).
 */

import type Database from 'better-sqlite3';
import {
  computeThesisScorecard,
  computeDataQualityFlags,
  computeRecentGraduationsEnriched,
  computeBestCombos,
} from './aggregates';
import { runDiagnosis } from './diagnose';
import {
  getGraduationCount,
  getLastBotError,
  getRecentTrades,
  getTradeStats,
  getTradeStatsByStrategy,
} from '../db/queries';
import { makeLogger } from '../utils/logger';
import type { LogBuffer } from '../utils/log-buffer';

const logger = makeLogger('gist-sync');

const GITHUB_API = 'https://api.github.com';
const OWNER = '50thycal';
const REPO = 'solana-graduation-arb-research';
const BRANCH = 'bot-status';
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

export interface StatusUrls {
  diagnose: string;
  snapshot: string;
  best_combos: string;
  trades: string;
  branch_html: string;
}

export class GistSync {
  private readonly db: Database.Database;
  private readonly logBuffer: LogBuffer;
  private readonly startTime: number;
  private readonly getListenerStats: () => unknown;
  private readonly token: string;
  private readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    db: Database.Database;
    logBuffer: LogBuffer;
    startTime: number;
    getListenerStats: () => unknown;
    token: string;
  }) {
    this.db = opts.db;
    this.logBuffer = opts.logBuffer;
    this.startTime = opts.startTime;
    this.getListenerStats = opts.getListenerStats;
    this.token = opts.token;
    this.intervalMs = parseInt(
      process.env.GIST_SYNC_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
      10,
    );
  }

  async start(): Promise<void> {
    await this.sync();

    this.timer = setInterval(() => {
      this.sync().catch((err) => logger.error({ err }, 'Status sync failed'));
    }, this.intervalMs);

    logger.info({ intervalMs: this.intervalMs, branch: BRANCH }, 'Status sync scheduled');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getUrls(): StatusUrls {
    const base = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
    return {
      diagnose: `${base}/diagnose.json`,
      snapshot: `${base}/snapshot.json`,
      best_combos: `${base}/best-combos.json`,
      trades: `${base}/trades.json`,
      branch_html: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    };
  }

  // ── private ──────────────────────────────────────────────────

  private buildPayloads(): Record<string, string> {
    const nowMs = Date.now();

    const diagnose = runDiagnosis(this.db, this.logBuffer);

    const scorecard = computeThesisScorecard(this.db);
    const quality = computeDataQualityFlags(this.db);
    const recent = computeRecentGraduationsEnriched(this.db, 10);
    const lastError = getLastBotError(this.db);
    const listenerStats = this.getListenerStats();

    const snapshot = {
      generated_at: new Date(nowMs).toISOString(),
      uptime_sec: Math.floor((nowMs - this.startTime) / 1000),
      counts: {
        graduations: getGraduationCount(this.db),
        momentum_labeled: scorecard.total_labeled,
        pump: scorecard.PUMP,
        dump: scorecard.DUMP,
        stable: scorecard.STABLE,
        unlabeled: scorecard.unlabeled,
      },
      scorecard,
      data_quality: quality,
      listener: listenerStats,
      recent_graduations: recent,
      last_error: lastError,
    };

    const bestCombos = computeBestCombos(this.db, {
      min_n: 20,
      top: 20,
      include_pairs: true,
    });

    const recentTrades = getRecentTrades(this.db, 50);
    const trades = {
      generated_at: new Date(nowMs).toISOString(),
      stats: getTradeStats(this.db),
      by_strategy: getTradeStatsByStrategy(this.db),
      count: recentTrades.length,
      trades: recentTrades,
    };

    return {
      'diagnose.json': JSON.stringify(diagnose, null, 2),
      'snapshot.json': JSON.stringify(snapshot, null, 2),
      'best-combos.json': JSON.stringify(bestCombos, null, 2),
      'trades.json': JSON.stringify(trades, null, 2),
    };
  }

  /**
   * Core sync: build a Git tree from scratch, create an orphan commit,
   * then force-update the bot-status ref. The branch always has exactly
   * one commit — no history accumulates.
   */
  private async sync(): Promise<void> {
    const payloads = this.buildPayloads();

    try {
      // 1. Create one blob per file.
      const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const [filename, content] of Object.entries(payloads)) {
        const blobResp = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/blobs`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
        });
        if (!blobResp.ok) {
          throw new Error(`Blob create failed for ${filename}: ${blobResp.status} ${await blobResp.text()}`);
        }
        const blob = (await blobResp.json()) as { sha: string };
        treeItems.push({ path: filename, mode: '100644', type: 'blob', sha: blob.sha });
      }

      // 2. Create a tree (no base_tree → clean root with only our files).
      const treeResp = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/trees`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ tree: treeItems }),
      });
      if (!treeResp.ok) {
        throw new Error(`Tree create failed: ${treeResp.status} ${await treeResp.text()}`);
      }
      const tree = (await treeResp.json()) as { sha: string };

      // 3. Create an orphan commit (no parents).
      const commitResp = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/commits`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          message: `bot: status update ${new Date().toISOString()} [skip ci]`,
          tree: tree.sha,
          parents: [],
        }),
      });
      if (!commitResp.ok) {
        throw new Error(`Commit create failed: ${commitResp.status} ${await commitResp.text()}`);
      }
      const commit = (await commitResp.json()) as { sha: string };

      // 4. Force-update (or create) the branch ref.
      const refUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`;
      const patchResp = await fetch(refUrl, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ sha: commit.sha, force: true }),
      });

      if (patchResp.status === 422 || patchResp.status === 404) {
        // Ref doesn't exist yet — create it.
        const createResp = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
        });
        if (!createResp.ok) {
          throw new Error(`Ref create failed: ${createResp.status} ${await createResp.text()}`);
        }
        logger.info({ branch: BRANCH }, 'bot-status branch created');
      } else if (!patchResp.ok) {
        throw new Error(`Ref update failed: ${patchResp.status} ${await patchResp.text()}`);
      }

      logger.debug({ branch: BRANCH, commit: commit.sha.slice(0, 7) }, 'Status updated');
    } catch (err) {
      logger.error({ err }, 'Status sync error');
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'solana-graduation-arb-research-bot',
    };
  }
}
