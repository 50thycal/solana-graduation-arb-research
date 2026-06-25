/**
 * src/api/gist-sync.ts
 *
 * Pushes the Claude-facing JSON views to a dedicated `bot-status` branch every
 * SYNC_INTERVAL_MS so Claude can self-serve via WebFetch / GitHub MCP tools.
 *
 * Copy-trading-only posture (post-refactor). Files published:
 *   - Infra:  diagnose.json, snapshot.json
 *   - Copy:   copy-trades.json, wallet-leaderboard.json, smart-money.json,
 *             copy-probe.json
 *   - Live:   live-training.json, live-execution.json
 *
 * The graduation-research panels (best-combos, panels, exit-sim, regime, etc.)
 * and the inbound strategy-commands.json apparatus were removed — copy
 * strategies are code-defined (COPY_STRATEGIES in copy-trader.ts) and the copy
 * journals live in docs/copy-trade-journal.md + docs/copy-strategy-lab.md.
 *
 * Uses the low-level GitHub Git Tree API + force-push so the branch always has
 * exactly ONE commit — no history accumulates regardless of sync frequency.
 *
 * Required env var: GITHUB_TOKEN — classic token with `public_repo` scope, or
 *   fine-grained token with Contents:Write permission.
 * Optional env var: GIST_SYNC_INTERVAL_MS — defaults to 120000 (2 min).
 */

import type Database from 'better-sqlite3';
import { runDiagnosis, type ChannelWinCounts } from './diagnose';
import { getEventLoopLagStats } from '../utils/event-loop-lag-monitor';
import { computeWalletLeaderboard } from '../copytrade/leaderboard';
import { getSmartMoneyAnalysis } from '../copytrade/smart-money';
import { computeCopyProbe } from '../copytrade/follower-probe';
import { computeCopyTrades } from '../copytrade/copy-trader';
import { computeLiveExecutionStats } from './live-execution-stats';
import { computeLiveTrainingData } from './live-training-data';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { getGraduationCount, getLastBotError } from '../db/queries';
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
  /** Shadow copy-trader P&L (the primary scoreboard). */
  copy_trades: string;
  /** Copy-trade wallet P&L leaderboard. */
  wallet_leaderboard: string;
  /** Copy-trade smart-money token-selection analysis. */
  smart_money: string;
  /** Copy-follower latency probe. */
  copy_probe: string;
  live_training: string;
  live_execution: string;
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

  // Track consecutive sync-cycle failures so transient GitHub network glitches
  // don't flood logs with identical error stacks. After the first failure we
  // drop to a single `warn` per cycle until recovery.
  private consecutiveFailures = 0;

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
      copy_trades: `${base}/copy-trades.json`,
      wallet_leaderboard: `${base}/wallet-leaderboard.json`,
      smart_money: `${base}/smart-money.json`,
      copy_probe: `${base}/copy-probe.json`,
      live_training: `${base}/live-training.json`,
      live_execution: `${base}/live-execution.json`,
      branch_html: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    };
  }

  // ── private ──────────────────────────────────────────────────

  private async buildPayloads(): Promise<Record<string, string>> {
    const nowMs = Date.now();

    // Pull live pipeline signals so diagnose.json + snapshot.json can surface a
    // stalled detection pipeline (WS dead, no candidates flowing). Listener
    // stats are best-effort.
    let pipelineWsConnected: boolean | null = null;
    let pipelineChannelWins: ChannelWinCounts | undefined = undefined;
    let pipelineLastCandidateSecAgo: number | null = null;
    try {
      const stats = this.getListenerStats() as {
        wsConnected?: boolean;
        channel_wins?: ChannelWinCounts;
        lastCandidateSecondsAgo?: number;
      } | null;
      if (stats && typeof stats.wsConnected === 'boolean') pipelineWsConnected = stats.wsConnected;
      if (stats && stats.channel_wins) pipelineChannelWins = stats.channel_wins;
      if (stats && typeof stats.lastCandidateSecondsAgo === 'number') {
        pipelineLastCandidateSecAgo = stats.lastCandidateSecondsAgo;
      }
    } catch { /* listener may not be initialized yet */ }

    // The graduation-arb StrategyManager (and its T+30 callback) was removed —
    // diagnose's trade-pipeline fields no longer apply, so pass neutral values.
    const diagnose = runDiagnosis(this.db, this.logBuffer, {
      wsConnected: pipelineWsConnected,
      lastT30CallbackAt: null,
      enabledStrategies: 0,
      channelWins: pipelineChannelWins,
      lastCandidateSecAgo: pipelineLastCandidateSecAgo,
    });

    const listenerStats = this.getListenerStats();
    const rpcLimiter = globalRpcLimiter.getStats();
    const eventLoopLag = getEventLoopLagStats();
    const lastError = getLastBotError(this.db);

    // Listener verified-vs-recorded dupe gap (detection-health diagnostic).
    const lst = (listenerStats as { totalVerifiedGraduations?: number; totalGraduationsRecorded?: number } | null) ?? null;
    const verified = lst?.totalVerifiedGraduations ?? 0;
    const recorded = lst?.totalGraduationsRecorded ?? 0;
    const dupePct = verified > 0 ? +(((verified - recorded) / verified) * 100).toFixed(1) : 0;

    const snapshot = {
      generated_at: new Date(nowMs).toISOString(),
      uptime_sec: Math.floor((nowMs - this.startTime) / 1000),
      counts: { graduations: getGraduationCount(this.db) },
      listener: listenerStats,
      listener_dedupe: { verified, recorded, dupe_pct: dupePct },
      rpc_limiter: rpcLimiter,
      pipeline_health: diagnose.pipeline_health,
      event_loop_lag: eventLoopLag,
      last_error: lastError,
    };

    // ── Copy-trade + live views (all cheap SQL / cache reads; no RPC) ──
    const walletLeaderboard = computeWalletLeaderboard(this.db);
    const smartMoney = getSmartMoneyAnalysis(this.db);
    const copyProbe = computeCopyProbe(this.db);
    const copyTrades = computeCopyTrades(this.db);
    const liveExecutionStats = computeLiveExecutionStats(this.db);
    const liveTrainingData = computeLiveTrainingData(this.db);

    return {
      'diagnose.json': JSON.stringify(diagnose, null, 2),
      'snapshot.json': JSON.stringify(snapshot, null, 2),
      'copy-trades.json': JSON.stringify(copyTrades, null, 2),
      'wallet-leaderboard.json': JSON.stringify(walletLeaderboard, null, 2),
      'smart-money.json': JSON.stringify(smartMoney, null, 2),
      'copy-probe.json': JSON.stringify(copyProbe, null, 2),
      'live-training.json': JSON.stringify(liveTrainingData, null, 2),
      'live-execution.json': JSON.stringify(liveExecutionStats, null, 2),
    };
  }

  /**
   * fetch() with retry on transient network failures (TypeError "fetch failed",
   * ETIMEDOUT, etc.) AND on 5xx responses. Up to 3 attempts with exponential
   * backoff (1s, 2s, 4s). 4xx responses are returned as-is — caller bugs, not
   * transient.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    opName: string,
  ): Promise<Response> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, init);
        if (resp.status >= 500 && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`${opName} got ${resp.status} ${resp.statusText}`);
          await this.sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${opName} failed: ${String(lastErr)}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Core sync: build status payloads, push to bot-status via the Git Tree API.
   */
  private async sync(): Promise<void> {
    const payloads = await this.buildPayloads();

    try {
      // 1. Create one blob per file.
      const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const [filename, content] of Object.entries(payloads)) {
        const blobResp = await this.fetchWithRetry(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/git/blobs`,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
          },
          `blob-create:${filename}`,
        );
        if (!blobResp.ok) {
          throw new Error(`Blob create failed for ${filename}: ${blobResp.status} ${await blobResp.text()}`);
        }
        const blob = (await blobResp.json()) as { sha: string };
        treeItems.push({ path: filename, mode: '100644', type: 'blob', sha: blob.sha });
      }

      // 2. Create a tree (no base_tree → clean root with only our files).
      const treeResp = await this.fetchWithRetry(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/git/trees`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ tree: treeItems }),
        },
        'tree-create',
      );
      if (!treeResp.ok) {
        throw new Error(`Tree create failed: ${treeResp.status} ${await treeResp.text()}`);
      }
      const tree = (await treeResp.json()) as { sha: string };

      // 3. Create an orphan commit (no parents).
      const commitResp = await this.fetchWithRetry(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/git/commits`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            message: `bot: status update ${new Date().toISOString()} [skip ci]`,
            tree: tree.sha,
            parents: [],
          }),
        },
        'commit-create',
      );
      if (!commitResp.ok) {
        throw new Error(`Commit create failed: ${commitResp.status} ${await commitResp.text()}`);
      }
      const commit = (await commitResp.json()) as { sha: string };

      // 4. Force-update (or create) the branch ref.
      const refUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`;
      const patchResp = await this.fetchWithRetry(
        refUrl,
        {
          method: 'PATCH',
          headers: this.headers(),
          body: JSON.stringify({ sha: commit.sha, force: true }),
        },
        'ref-patch',
      );

      if (patchResp.status === 422 || patchResp.status === 404) {
        // Ref doesn't exist yet — create it.
        const createResp = await this.fetchWithRetry(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
          },
          'ref-create',
        );
        if (!createResp.ok) {
          throw new Error(`Ref create failed: ${createResp.status} ${await createResp.text()}`);
        }
        logger.info({ branch: BRANCH }, 'bot-status branch created');
      } else if (!patchResp.ok) {
        throw new Error(`Ref update failed: ${patchResp.status} ${await patchResp.text()}`);
      }

      if (this.consecutiveFailures > 0) {
        logger.info(
          { recoveredAfterFailures: this.consecutiveFailures, branch: BRANCH },
          'Status sync recovered',
        );
        this.consecutiveFailures = 0;
      }
      logger.debug({ branch: BRANCH, commit: commit.sha.slice(0, 7) }, 'Status updated');
    } catch (err) {
      this.consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (this.consecutiveFailures === 1) {
        logger.error({ err }, 'Status sync error');
      } else {
        logger.warn(
          { consecutiveFailures: this.consecutiveFailures, lastError: message },
          'Status sync still degraded',
        );
      }
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
