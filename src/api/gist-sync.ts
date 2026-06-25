/**
 * src/api/gist-sync.ts
 *
 * Pushes the Claude-facing JSON views to a dedicated `bot-status` branch every
 * SYNC_INTERVAL_MS so Claude can self-serve via WebFetch / GitHub MCP tools.
 *
 * Copy-trading-only posture (post-refactor). Files published:
 *   - Infra:  diagnose.json, snapshot.json, logs.json, bot-errors.json
 *   - Copy:   copy-trades.json, wallet-leaderboard.json, smart-money.json,
 *             copy-probe.json
 *   - Live:   live-training.json, live-execution.json
 *   - Self-serve DB: db-query-results.json (results of an inbound db-query.json)
 *
 * The graduation-research panels and the inbound strategy-commands.json
 * apparatus were removed — copy strategies are code-defined (COPY_STRATEGIES in
 * copy-trader.ts) and the copy journals live in docs/copy-trade-journal.md +
 * docs/copy-strategy-lab.md. The ad-hoc read-only DB query channel
 * (db-query.json → db-query-results.json) is retained.
 *
 * Uses the low-level GitHub Git Tree API + force-push so the branch always has
 * exactly ONE commit — no history accumulates regardless of sync frequency.
 *
 * Required env var: GITHUB_TOKEN — classic token with `public_repo` scope, or
 *   fine-grained token with Contents:Write permission.
 * Optional env var: GIST_SYNC_INTERVAL_MS — defaults to 120000 (2 min).
 */

import Database from 'better-sqlite3';
import { runDiagnosis, type ChannelWinCounts } from './diagnose';
import { getEventLoopLagStats } from '../utils/event-loop-lag-monitor';
import { computeWalletLeaderboard } from '../copytrade/leaderboard';
import { getSmartMoneyAnalysis } from '../copytrade/smart-money';
import { computeCopyProbe } from '../copytrade/follower-probe';
import { computeCopyTrades } from '../copytrade/copy-trader';
import { computeLiveExecutionStats } from './live-execution-stats';
import { computeLiveTrainingData } from './live-training-data';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { getGraduationCount, getLastBotError, getRecentBotErrors } from '../db/queries';
import { makeLogger } from '../utils/logger';
import type { LogBuffer } from '../utils/log-buffer';

const logger = makeLogger('gist-sync');

const GITHUB_API = 'https://api.github.com';
const OWNER = '50thycal';
const REPO = 'solana-graduation-arb-research';
const BRANCH = 'bot-status';
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

// Inbound ad-hoc DB query channel: Claude pushes db-query.json to the main
// branch ({ queries: [{ id, sql, max_rows }] }); the bot runs each as a guarded
// read-only SELECT and publishes the outcome to db-query-results.json.
const DB_QUERY_FILE = 'db-query.json';

// How many recent log-buffer entries to publish to logs.json each sync cycle.
const LOG_SYNC_LIMIT = parseInt(process.env.LOG_SYNC_LIMIT ?? '1500', 10) || 1500;

// Hard ceiling on rows returned by an ad-hoc DB query, regardless of the
// per-query max_rows. Bounds memory + the size of db-query-results.json.
const DB_QUERY_HARD_ROW_CAP = 50_000;
const DB_QUERY_DEFAULT_ROW_CAP = 1000;

function resolveDbPath(db: Database.Database): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filename = (db as any).name as string | undefined;
  if (!filename) throw new Error('Cannot resolve DB path from better-sqlite3 handle');
  return filename;
}

/** One read-only query request inside db-query.json (pushed to main by Claude). */
interface DbQueryRequest {
  id: string;
  sql: string;
  max_rows?: number;
}
interface DbQueryFile {
  queries: DbQueryRequest[];
}
/** One query's outcome, published in db-query-results.json on bot-status. */
interface DbQueryResult {
  id: string;
  sql: string;
  ok: boolean;
  error?: string;
  columns?: string[];
  rows?: unknown[];
  row_count?: number;
  truncated?: boolean;
  elapsed_ms?: number;
}
interface DbQueryResultsFile {
  generated_at: string;
  processed_at: string | null;
  query_count: number;
  results: DbQueryResult[];
}

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
  // don't flood logs with identical error stacks.
  private consecutiveFailures = 0;

  // Outcome of the most recent inbound db-query.json — published as
  // db-query-results.json by buildPayloads on the same sync cycle.
  private lastDbQueryResults: DbQueryResultsFile | null = null;

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

  // ── Inbound ad-hoc DB queries ───────────────────────────────────
  /**
   * Check for db-query.json on the main branch. Each query is run as a guarded
   * read-only SELECT on a dedicated short-lived readonly connection (never the
   * shared read-write handle) and the outcome is stashed for db-query-results.json.
   */
  private async processDbQueries(): Promise<void> {
    let fileInfo: { sha: string; content: string };
    try {
      const resp = await fetch(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DB_QUERY_FILE}?ref=main`,
        { headers: this.headers() },
      );
      if (resp.status === 404) return; // No query pending
      if (!resp.ok) {
        logger.debug('Inbound db-query check returned %d', resp.status);
        return;
      }
      fileInfo = (await resp.json()) as { sha: string; content: string };
    } catch (err) {
      logger.warn({ err }, 'Inbound db-query check failed — will retry next cycle');
      return;
    }

    const content = Buffer.from(fileInfo.content, 'base64').toString('utf-8');
    let parsed: DbQueryFile;
    try {
      parsed = JSON.parse(content) as DbQueryFile;
    } catch {
      logger.error('Failed to parse db-query.json — deleting');
      await this.deleteDbQueryFile(fileInfo.sha);
      return;
    }

    const queries = Array.isArray(parsed.queries) ? parsed.queries : [];
    const results: DbQueryResult[] = [];
    for (const q of queries) {
      if (!q || typeof q.sql !== 'string' || typeof q.id !== 'string') {
        results.push({ id: q?.id ?? '(missing id)', sql: q?.sql ?? '', ok: false, error: 'each query needs string id + sql' });
        continue;
      }
      results.push(this.executeDbQuery(q.id, q.sql, q.max_rows));
    }

    this.lastDbQueryResults = {
      generated_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      query_count: results.length,
      results,
    };
    logger.info({ query_count: results.length }, 'Processed inbound DB queries');
    await this.deleteDbQueryFile(fileInfo.sha);
  }

  /** Run one guarded read-only query and shape it into a DbQueryResult. */
  private executeDbQuery(id: string, sql: string, maxRows?: number): DbQueryResult {
    const startedAt = Date.now();
    const cap = Math.min(
      Math.max(1, Number.isFinite(maxRows as number) ? (maxRows as number) : DB_QUERY_DEFAULT_ROW_CAP),
      DB_QUERY_HARD_ROW_CAP,
    );

    // CRITICAL: run ad-hoc Claude queries on a DEDICATED, short-lived read-only
    // connection — never the shared read-write `this.db` handle that the
    // collector and buildPayloads use. Running .iterate()/.columns() on the
    // shared handle hard-crashed the process (native better-sqlite3 abort, no
    // catchable JS error). Opening our own readonly handle isolates the blast
    // radius; we close it in `finally`. Columns are derived from the first row's
    // keys rather than the native `.columns()` call (another crash vector).
    let conn: Database.Database | null = null;
    try {
      conn = new Database(resolveDbPath(this.db), { readonly: true, fileMustExist: true });
      conn.pragma('busy_timeout = 5000');

      let stmt: Database.Statement;
      try {
        // better-sqlite3.prepare() compiles exactly one statement and throws on a
        // multi-statement string, so "SELECT 1; DROP TABLE x" never reaches exec.
        stmt = conn.prepare(sql);
      } catch (err) {
        return { id, sql, ok: false, error: `prepare failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!stmt.readonly) {
        return { id, sql, ok: false, error: 'rejected: only read-only queries are allowed (statement writes or is DDL/PRAGMA-write)' };
      }
      if (!stmt.reader) {
        return { id, sql, ok: false, error: 'rejected: query returns no rows (must be a SELECT or other row-returning read)' };
      }
      const rows: unknown[] = [];
      let truncated = false;
      try {
        for (const row of stmt.iterate()) {
          if (rows.length >= cap) { truncated = true; break; }
          rows.push(row);
        }
      } catch (err) {
        return { id, sql, ok: false, error: `execution failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const first = rows[0];
      const columns = first && typeof first === 'object' && !Array.isArray(first)
        ? Object.keys(first as Record<string, unknown>)
        : [];
      return {
        id, sql, ok: true, columns, rows,
        row_count: rows.length, truncated, elapsed_ms: Date.now() - startedAt,
      };
    } catch (err) {
      return { id, sql, ok: false, error: `query connection failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (conn) {
        try { conn.close(); } catch { /* ignore — best-effort cleanup */ }
      }
    }
  }

  private async deleteDbQueryFile(sha: string): Promise<void> {
    try {
      await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DB_QUERY_FILE}`, {
        method: 'DELETE',
        headers: this.headers(),
        body: JSON.stringify({ message: 'bot: processed db query [skip ci]', sha }),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to delete db-query.json');
    }
  }

  // ── private ──────────────────────────────────────────────────

  private async buildPayloads(): Promise<Record<string, string>> {
    const nowMs = Date.now();
    const genAt = new Date(nowMs).toISOString();

    // Pull live pipeline signals so diagnose.json + snapshot.json can surface a
    // stalled detection pipeline (WS dead, no candidates flowing).
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
      generated_at: genAt,
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

      // ── Log + error + DB self-service ──
      'logs.json': JSON.stringify({
        generated_at: genAt,
        buffer_size: this.logBuffer.size(),
        tail_limit: LOG_SYNC_LIMIT,
        entries: this.logBuffer.query({ limit: LOG_SYNC_LIMIT }),
        warn_error_entries: this.logBuffer.query({ level: 'warn', limit: 500 }),
      }, null, 2),
      'bot-errors.json': JSON.stringify({
        generated_at: genAt,
        last_error: getLastBotError(this.db),
        recent: getRecentBotErrors(this.db, 20),
      }, null, 2),
      'db-query-results.json': JSON.stringify(
        this.lastDbQueryResults ?? {
          generated_at: genAt,
          processed_at: null,
          query_count: 0,
          results: [],
          note: 'No DB query has run yet. Push db-query.json to the main branch ({ "queries": [{ "id", "sql", "max_rows" }] }) to run a read-only SELECT; results land here on the next sync (~2 min).',
        },
        null, 2,
      ),
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
   * Core sync: process inbound DB queries, build status payloads, push to
   * bot-status via the Git Tree API.
   */
  private async sync(): Promise<void> {
    // Process any inbound ad-hoc DB queries so their results ride out on this
    // same push cycle (db-query-results.json is built inside buildPayloads).
    await this.processDbQueries();

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
