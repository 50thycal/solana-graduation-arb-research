/**
 * src/api/gist-sync.ts
 *
 * Pushes every Claude-facing JSON view to a dedicated `bot-status` branch every
 * SYNC_INTERVAL_MS so Claude can self-serve via WebFetch / GitHub MCP tools.
 *
 * Files published (see buildPayloads for full list):
 *   - Core: diagnose.json, snapshot.json, best-combos.json, strategies.json
 *   - Trades/trading: trades.json, trading.json
 *   - /filter-analysis-v2: panel1.json, panel2.json, panel3.json, panel4.json,
 *     panel5.json, panel6.json, panel7.json, panel8.json, panel9.json,
 *     panel10.json, panel11.json
 *   - /price-path: price-path-stats.json (compact), price-path-detail.json (full)
 *   - /peak-analysis: peak-analysis.json
 *
 * Also polls for `strategy-commands.json` on the main branch — when found,
 * applies the commands (upsert/delete/toggle strategies) and deletes the file.
 * This lets Claude push strategy configs via git without needing direct API access.
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
import { computePanel11 } from './panel11';
import { computePanel3Summary } from './panel3-summary';
import { computePricePathStats } from './price-path-stats';
import { computePeakAnalysis } from './peak-analysis';
import { computeExitSim } from './exit-sim';
import { computeTradingData } from './trading-data';
import { getHeavyData } from './heavy-cache';
import {
  getGraduationCount,
  getLastBotError,
  getRecentTrades,
  getTradeStats,
  getTradeStatsByStrategy,
  getStrategyConfigs,
} from '../db/queries';
import type { StrategyManager } from '../trading/strategy-manager';
import type { StrategyParams } from '../trading/config';
import { makeLogger } from '../utils/logger';
import type { LogBuffer } from '../utils/log-buffer';

const logger = makeLogger('gist-sync');

const GITHUB_API = 'https://api.github.com';
const OWNER = '50thycal';
const REPO = 'solana-graduation-arb-research';
const BRANCH = 'bot-status';
const COMMANDS_FILE = 'strategy-commands.json';
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

export interface StatusUrls {
  diagnose: string;
  snapshot: string;
  best_combos: string;
  trades: string;
  panel11: string;
  panel3: string;
  price_path_stats: string;
  peak_analysis: string;
  strategies: string;
  exit_sim: string;
  // New files (overhaul 2026-04-17): per-panel filter-v2 slices, full price-path
  // detail with raw overlay paths, and full /trading dashboard data.
  panel1: string;
  panel2: string;
  panel4: string;
  panel5: string;
  panel6: string;
  panel7: string;
  panel8: string;
  panel9: string;
  panel10: string;
  price_path_detail: string;
  trading: string;
  branch_html: string;
}

interface StrategyCommand {
  action: 'upsert' | 'delete' | 'toggle';
  id: string;
  label?: string;
  enabled?: boolean;
  params?: StrategyParams;
}

interface StrategyCommandsFile {
  commands: StrategyCommand[];
}

export class GistSync {
  private readonly db: Database.Database;
  private readonly logBuffer: LogBuffer;
  private readonly startTime: number;
  private readonly getListenerStats: () => unknown;
  private readonly token: string;
  private readonly intervalMs: number;
  private strategyManager: StrategyManager | null = null;

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

  /** Wire up the strategy manager so inbound commands can be applied live */
  setStrategyManager(sm: StrategyManager): void {
    this.strategyManager = sm;
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
      panel11: `${base}/panel11.json`,
      panel3: `${base}/panel3.json`,
      price_path_stats: `${base}/price-path-stats.json`,
      peak_analysis: `${base}/peak-analysis.json`,
      strategies: `${base}/strategies.json`,
      exit_sim: `${base}/exit-sim.json`,
      panel1: `${base}/panel1.json`,
      panel2: `${base}/panel2.json`,
      panel4: `${base}/panel4.json`,
      panel5: `${base}/panel5.json`,
      panel6: `${base}/panel6.json`,
      panel7: `${base}/panel7.json`,
      panel8: `${base}/panel8.json`,
      panel9: `${base}/panel9.json`,
      panel10: `${base}/panel10.json`,
      price_path_detail: `${base}/price-path-detail.json`,
      trading: `${base}/trading.json`,
      branch_html: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    };
  }

  // ── Inbound strategy commands ───────────────────────────────────

  /**
   * Check for strategy-commands.json on the main branch. If found,
   * apply each command (upsert/delete/toggle) and delete the file.
   * Runs at the start of each sync cycle.
   */
  private async processInboundCommands(): Promise<void> {
    if (!this.strategyManager) return;

    try {
      const resp = await fetch(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${COMMANDS_FILE}?ref=main`,
        { headers: this.headers() },
      );

      if (resp.status === 404) return; // No commands pending
      if (!resp.ok) {
        logger.debug('Inbound commands check returned %d', resp.status);
        return;
      }

      const fileInfo = (await resp.json()) as { sha: string; content: string };
      const content = Buffer.from(fileInfo.content, 'base64').toString('utf-8');
      let commands: StrategyCommandsFile;
      try {
        commands = JSON.parse(content) as StrategyCommandsFile;
      } catch {
        logger.error('Failed to parse strategy-commands.json — deleting');
        await this.deleteCommandsFile(fileInfo.sha);
        return;
      }

      if (!Array.isArray(commands.commands) || commands.commands.length === 0) {
        await this.deleteCommandsFile(fileInfo.sha);
        return;
      }

      const results: Array<{ id: string; action: string; ok: boolean; error?: string }> = [];

      for (const cmd of commands.commands) {
        try {
          if (cmd.action === 'upsert' && cmd.params && cmd.label) {
            this.strategyManager.upsertStrategy(
              cmd.id, cmd.label, cmd.params, cmd.enabled !== false,
            );
            results.push({ id: cmd.id, action: 'upsert', ok: true });
          } else if (cmd.action === 'delete') {
            const result = this.strategyManager.deleteStrategy(cmd.id);
            results.push({
              id: cmd.id, action: 'delete',
              ok: !result.error, error: result.error,
            });
          } else if (cmd.action === 'toggle') {
            this.strategyManager.toggleStrategy(cmd.id, cmd.enabled ?? true);
            results.push({ id: cmd.id, action: 'toggle', ok: true });
          } else {
            results.push({ id: cmd.id, action: cmd.action, ok: false, error: 'invalid command' });
          }
        } catch (err) {
          results.push({
            id: cmd.id, action: cmd.action, ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Delete the commands file after processing
      await this.deleteCommandsFile(fileInfo.sha);

      logger.info(
        { results, commandCount: commands.commands.length },
        'Inbound strategy commands processed',
      );
    } catch (err) {
      logger.error({ err }, 'Error checking inbound strategy commands');
    }
  }

  private async deleteCommandsFile(sha: string): Promise<void> {
    try {
      await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${COMMANDS_FILE}`, {
        method: 'DELETE',
        headers: this.headers(),
        body: JSON.stringify({
          message: 'bot: processed strategy commands [skip ci]',
          sha,
        }),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to delete strategy-commands.json');
    }
  }

  // ── private ──────────────────────────────────────────────────

  private buildPayloads(): Record<string, string> {
    const nowMs = Date.now();

    const diagnose = runDiagnosis(this.db, this.logBuffer);

    // Compute leaderboard first so we can pass the live leader into the scorecard.
    const bestCombos = computeBestCombos(this.db, {
      min_n: 20,
      top: 20,
      include_pairs: true,
    });

    // Find the best combo with n≥100 that beats the old baseline — this becomes
    // the live best_known_baseline shown in snapshot.json.
    const liveLeader = bestCombos.rows
      .filter(r => r.n >= 100 && r.beats_baseline && r.sim_avg_return_10sl_50tp_pct != null)
      .sort((a, b) => (b.sim_avg_return_10sl_50tp_pct ?? 0) - (a.sim_avg_return_10sl_50tp_pct ?? 0))[0];

    const scorecard = computeThesisScorecard(this.db, liveLeader);
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

    const recentTrades = getRecentTrades(this.db, 50);
    const trades = {
      generated_at: new Date(nowMs).toISOString(),
      stats: getTradeStats(this.db),
      by_strategy: getTradeStatsByStrategy(this.db),
      count: recentTrades.length,
      trades: recentTrades,
    };

    const panel11 = computePanel11(this.db);
    const panel3 = computePanel3Summary(this.db);
    const pricePathStats = computePricePathStats(this.db);
    const peakAnalysis = computePeakAnalysis(this.db);
    const exitSim = computeExitSim(this.db);

    // Heavy compute (filter-v2 panels, price-path detail, trading data) is
    // cached with a 24h TTL — computeFilterV2Data alone is ~100s at current
    // data volume, and running it every 2-min sync was blocking the Node
    // event loop long enough to 502 live dashboard requests. Cache refreshes
    // on boot (first call) and at most once/day after that. Each sync cycle
    // still re-publishes the cached JSON strings so all files stay on
    // bot-status.
    const heavy = getHeavyData(this.db, this.strategyManager);
    const v2 = heavy.v2;
    const pricePathDetail = heavy.pricePathDetail;
    // Don't reuse heavy.tradingData — strategies/config can drift from what
    // was captured at the last heavy cache refresh (up to 24h old). Recompute
    // fresh each sync cycle so trading.json on bot-status reflects live
    // strategy state. The queries inside computeTradingData are all <100ms.
    const tradingData = computeTradingData(this.db, this.strategyManager, {
      topPairs: v2.panel6.top_pairs,
    });

    // Strategy configs — includes all DPM params per strategy
    const strategyRows = getStrategyConfigs(this.db);
    const strategies = strategyRows.map(row => ({
      id: row.id,
      label: row.label,
      enabled: row.enabled === 1,
      params: JSON.parse(row.config_json),
    }));

    const genAt = new Date(nowMs).toISOString();

    // Panel 6 sync shape: omit the URL-driven `dynamic` slice (needs user input)
    // and keep only the auto-scanned `top_pairs*` leaderboards.
    const panel6Published = {
      title: v2.panel6.title,
      description: v2.panel6.description,
      filter_names: v2.panel6.filter_names,
      top_pairs: v2.panel6.top_pairs,
      top_pairs_t60: v2.panel6.top_pairs_t60,
      top_pairs_t120: v2.panel6.top_pairs_t120,
      flags: v2.panel6.flags,
    };

    return {
      // Existing files — unchanged for backwards compat with stale sessions.
      'diagnose.json': JSON.stringify(diagnose, null, 2),
      'snapshot.json': JSON.stringify(snapshot, null, 2),
      'best-combos.json': JSON.stringify(bestCombos, null, 2),
      'trades.json': JSON.stringify(trades, null, 2),
      'panel11.json': JSON.stringify(panel11, null, 2),
      'panel3.json': JSON.stringify(panel3, null, 2),
      'price-path-stats.json': JSON.stringify(pricePathStats, null, 2),
      'peak-analysis.json': JSON.stringify(peakAnalysis, null, 2),
      'exit-sim.json': JSON.stringify(exitSim, null, 2),
      'strategies.json': JSON.stringify({
        generated_at: genAt,
        count: strategies.length,
        strategies,
      }, null, 2),

      // New files (overhaul 2026-04-17): per-panel slices from /filter-analysis-v2
      // + full price-path detail with raw overlay + full /trading dashboard data.
      'panel1.json': JSON.stringify({
        generated_at: genAt,
        panel1: v2.panel1,
        panel1_t60: v2.panel1_t60,
        panel1_t120: v2.panel1_t120,
      }, null, 2),
      'panel2.json': JSON.stringify({
        generated_at: genAt,
        panel2: v2.panel2,
      }, null, 2),
      'panel4.json': JSON.stringify({
        generated_at: genAt,
        panel4: v2.panel4,
        panel4_t60: v2.panel4_t60,
        panel4_t120: v2.panel4_t120,
      }, null, 2),
      'panel5.json': JSON.stringify({
        generated_at: genAt,
        panel5: v2.panel5,
      }, null, 2),
      'panel6.json': JSON.stringify({
        generated_at: genAt,
        panel6: panel6Published,
      }, null, 2),
      'panel7.json': JSON.stringify({
        generated_at: genAt,
        panel7: v2.panel7,
      }, null, 2),
      'panel8.json': JSON.stringify({
        generated_at: genAt,
        panel8: v2.panel8,
      }, null, 2),
      'panel9.json': JSON.stringify({
        generated_at: genAt,
        panel9: v2.panel9,
      }, null, 2),
      'panel10.json': JSON.stringify({
        generated_at: genAt,
        panel10: v2.panel10,
      }, null, 2),
      'price-path-detail.json': JSON.stringify(pricePathDetail, null, 2),
      'trading.json': JSON.stringify(tradingData, null, 2),
    };
  }

  /**
   * Core sync: process inbound commands, build status payloads, push to bot-status.
   */
  private async sync(): Promise<void> {
    // Process any inbound strategy commands before building status
    await this.processInboundCommands();

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
