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
import { runDiagnosis, type ChannelWinCounts } from './diagnose';
import { getEventLoopLagStats } from '../utils/event-loop-lag-monitor';
import { computePanel11 } from './panel11';
import { computePanel3Summary } from './panel3-summary';
import { computePricePathStats } from './price-path-stats';
import { computePeakAnalysis } from './peak-analysis';
import { computeExitSim } from './exit-sim';
import { computeExitSimMatrix } from './exit-sim-matrix';
import { computeEntryTimeMatrix } from './entry-time-matrix';
import { computeWalletRepAnalysis } from './wallet-rep-analysis';
import { computeSniperPanel } from './sniper-panel';
import { computeStrategyPercentiles } from './strategy-percentiles';
import { computeJournal } from './journal';
import { computeEdgeDecay } from './edge-decay';
import { computeCounterfactual } from './counterfactual';
import { computeLossPostmortem } from './loss-postmortem';
import { computeTradingData } from './trading-data';
import { computeLiveExecutionStats } from './live-execution-stats';
import { getHeavyData } from './heavy-cache';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import {
  getGraduationCount,
  getLastBotError,
  getRecentTrades,
  getTradeStats,
  getTradeStatsByStrategy,
  getStrategyConfigs,
  upsertJournalEntry,
  appendJournalUpdate,
  deleteJournalEntry,
  type JournalPrediction,
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

// Heavy compute panels — entryTimeMatrix walks ~60 catalog filters × 6 entry
// checkpoints × the 12×10 sim grid every cycle, exitSimMatrix runs the dynamic
// exit grids over the top 20 combos, walletRepAnalysis layers rep modifiers
// over them. Each one was adding seconds of synchronous main-thread work per
// 2-min sync cycle, which queued every HTTP request behind it (dashboard /,
// /pipeline, /trading all stuck for minutes — Railway 408s in production).
//
// Default OFF; set SYNC_HEAVY_PANELS=true on Railway to re-enable. When off
// we still publish a small stub for each so the file exists on bot-status
// and downstream consumers don't 404.
const HEAVY_PANELS_ENABLED = process.env.SYNC_HEAVY_PANELS === 'true';

/** Yield to the event loop between heavy compute phases so queued HTTP
 *  requests can drain. better-sqlite3 is synchronous, so without this the
 *  full sync pipeline holds the loop hostage end-to-end. */
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function disabledPanelStub(name: string): { disabled: true; panel: string; reason: string; generated_at: string } {
  return {
    disabled: true,
    panel: name,
    reason: 'Heavy compute panel disabled (SYNC_HEAVY_PANELS!=true) to keep the dashboard responsive. Set SYNC_HEAVY_PANELS=true to re-enable.',
    generated_at: new Date().toISOString(),
  };
}

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
  wallet_rep_analysis: string;
  sniper_panel: string;
  strategy_percentiles: string;
  exit_sim_matrix: string;
  entry_time_matrix: string;
  // Trading-page research panels (2026-05-07): journal, edge-decay,
  // filter+TP/SL counterfactual, and loss-postmortem clusterer.
  journal: string;
  edge_decay: string;
  counterfactual: string;
  loss_postmortem: string;
  branch_html: string;
}

/**
 * Inbound command shape. The handler dispatches on `action`:
 *
 *   upsert / delete / toggle      — strategy CRUD (existing).
 *   journal-upsert                — create or replace a journal entry.
 *   journal-update                — append an update note to an existing entry.
 *   journal-delete                — remove a journal entry.
 *
 * Field requirements per action are enforced at dispatch time, not in the
 * type, so Claude / the operator gets a clear validation error in
 * command-results.json instead of a silent rejection.
 */
interface StrategyCommand {
  action:
    | 'upsert' | 'delete' | 'toggle'
    | 'journal-upsert' | 'journal-update' | 'journal-delete';
  id: string;
  // upsert / toggle
  label?: string;
  enabled?: boolean;
  params?: StrategyParams;
  // journal-upsert
  strategy_id?: string;
  cohort_label?: string | null;
  hypothesis?: string;
  prediction?: JournalPrediction | null;
  status?: string;
  // journal-update
  note?: string;
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

  // Track consecutive sync-cycle failures so transient GitHub network glitches
  // don't flood Railway logs with identical error stacks. After the first
  // failure we drop to a single `warn` per cycle until recovery.
  private consecutiveFailures = 0;

  // Ring buffer of recent inbound-command batches. Each entry captures one
  // processInboundCommands() invocation that found a non-empty file. Surfaced
  // as command-results.json on bot-status so callers can see why a strategy
  // upsert was rejected (e.g. id-length violation) without reading bot logs.
  // Bounded at 20 batches — enough history to investigate any recent push.
  private recentCommandBatches: Array<{
    processed_at: string;
    command_count: number;
    results: Array<{ id: string; action: string; ok: boolean; error?: string }>;
  }> = [];
  private static readonly COMMAND_BATCH_HISTORY = 20;

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
      exit_sim_matrix: `${base}/exit-sim-matrix.json`,
      entry_time_matrix: `${base}/entry-time-matrix.json`,
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
      wallet_rep_analysis: `${base}/wallet-rep-analysis.json`,
      sniper_panel: `${base}/sniper-panel.json`,
      strategy_percentiles: `${base}/strategy-percentiles.json`,
      journal: `${base}/journal.json`,
      edge_decay: `${base}/edge-decay.json`,
      counterfactual: `${base}/counterfactual.json`,
      loss_postmortem: `${base}/loss-postmortem.json`,
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
          } else if (cmd.action === 'journal-upsert') {
            // strategy_id + hypothesis are required; everything else has a sensible default.
            if (!cmd.strategy_id || !cmd.hypothesis) {
              results.push({ id: cmd.id, action: 'journal-upsert', ok: false, error: 'strategy_id and hypothesis are required' });
            } else {
              upsertJournalEntry(this.db, {
                id: cmd.id,
                strategy_id: cmd.strategy_id,
                cohort_label: cmd.cohort_label ?? null,
                hypothesis: cmd.hypothesis,
                prediction: cmd.prediction ?? null,
                status: cmd.status,
              });
              results.push({ id: cmd.id, action: 'journal-upsert', ok: true });
            }
          } else if (cmd.action === 'journal-update') {
            if (!cmd.note) {
              results.push({ id: cmd.id, action: 'journal-update', ok: false, error: 'note is required' });
            } else {
              const r = appendJournalUpdate(this.db, cmd.id, cmd.note);
              results.push({ id: cmd.id, action: 'journal-update', ok: r.ok, error: r.error });
            }
          } else if (cmd.action === 'journal-delete') {
            deleteJournalEntry(this.db, cmd.id);
            results.push({ id: cmd.id, action: 'journal-delete', ok: true });
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

      // Record into the ring buffer so command-results.json on bot-status
      // exposes per-command outcomes (rejected ids, validation errors, etc).
      this.recentCommandBatches.unshift({
        processed_at: new Date().toISOString(),
        command_count: commands.commands.length,
        results,
      });
      if (this.recentCommandBatches.length > GistSync.COMMAND_BATCH_HISTORY) {
        this.recentCommandBatches.length = GistSync.COMMAND_BATCH_HISTORY;
      }

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

  private async buildPayloads(): Promise<Record<string, string>> {
    const nowMs = Date.now();

    // Pull live pipeline signals so /api/diagnose and snapshot.json can
    // surface a stalled trade pipeline (WS dead, T+30 callbacks silent, no
    // entries flowing). Listener stats are best-effort — shape varies but
    // wsConnected is the only field we need for the watchdog.
    let pipelineWsConnected: boolean | null = null;
    let pipelineChannelWins: ChannelWinCounts | undefined = undefined;
    try {
      const stats = this.getListenerStats() as {
        wsConnected?: boolean;
        channel_wins?: ChannelWinCounts;
      } | null;
      if (stats && typeof stats.wsConnected === 'boolean') {
        pipelineWsConnected = stats.wsConnected;
      }
      if (stats && stats.channel_wins) pipelineChannelWins = stats.channel_wins;
    } catch { /* listener may not be initialized yet */ }

    const enabledStrategies = this.strategyManager
      ? this.strategyManager.getStrategies().filter(s => s.enabled).length
      : 0;
    const lastT30CallbackAt = this.strategyManager?.getLastT30CallbackAt() ?? null;

    // Per-step timings for buildPayloads. Aggregated into the `timings` object
    // built below (main thread compute stages) and surfaced on snapshot.json
    // under gist_sync_compute_ms so we can pinpoint which compute step is
    // monopolizing the main thread without needing live log access. The yield
    // helper (yieldEventLoop) inside the main panel block keeps HTTP requests
    // draining between phases — see HEAVY_PANELS_ENABLED comment.
    const diagnose = runDiagnosis(this.db, this.logBuffer, {
      wsConnected: pipelineWsConnected,
      lastT30CallbackAt,
      enabledStrategies,
      channelWins: pipelineChannelWins,
    });

    // Compute leaderboard first so we can pass the live leader into the scorecard.
    const bestCombosT0 = Date.now();
    const bestCombos = await computeBestCombos(this.db, {
      min_n: 20,
      top: 20,
      include_pairs: true,
    });
    const bestCombosMs = Date.now() - bestCombosT0;
    await yieldEventLoop();

    // Find the best combo with n≥100 that beats the rolling entry-gated
    // baseline — this becomes the live best_known_baseline shown in
    // snapshot.json. Ranking is by opt_avg_ret (per-combo TP/SL optimum),
    // matching Panel 6's top_pairs approach.
    const liveLeader = bestCombos.rows
      .filter(r => r.n >= 100 && r.beats_baseline && r.opt_avg_ret != null)
      .sort((a, b) => (b.opt_avg_ret ?? 0) - (a.opt_avg_ret ?? 0))[0];

    const scorecard = computeThesisScorecard(this.db, liveLeader);
    const quality = computeDataQualityFlags(this.db);
    const recent = computeRecentGraduationsEnriched(this.db, 10);
    const lastError = getLastBotError(this.db);
    const listenerStats = this.getListenerStats();

    // Singleton RPC limiter stats — useful upstream of pipeline_health so the
    // operator can see whether observations are stalling because the limiter
    // is dropping requests. tokensAvailable near 0 + queued > 0 + drops/min
    // climbing = Helius is the bottleneck, not our code.
    const rpcLimiter = globalRpcLimiter.getStats();

    // Listener verified-vs-recorded gap. When totalVerifiedGraduations grows
    // faster than totalGraduationsRecorded, the listener is processing the
    // same migration tx multiple times (WS replay or duplicate handleLogs
    // delivery). Surfacing the ratio here so it doesn't masquerade as a
    // PriceCollector problem — observations only ever start on a recorded
    // graduation, so a 78% dupe rate (seen in production after restart)
    // means 78% of verified graduations get no observation at all.
    const lst = (listenerStats as { totalVerifiedGraduations?: number; totalGraduationsRecorded?: number } | null) ?? null;
    const verified = lst?.totalVerifiedGraduations ?? 0;
    const recorded = lst?.totalGraduationsRecorded ?? 0;
    const dupePct = verified > 0 ? +(((verified - recorded) / verified) * 100).toFixed(1) : 0;

    // Build snapshot AFTER the panel block runs so `timings` is fully
    // populated. snapshot is consumed by the JSON payload writer further
    // below — no early callers depend on it.
    const recentTrades = getRecentTrades(this.db, 50);
    const trades = {
      generated_at: new Date(nowMs).toISOString(),
      stats: getTradeStats(this.db),
      by_strategy: getTradeStatsByStrategy(this.db),
      count: recentTrades.length,
      trades: recentTrades,
    };

    // Run each compute, log its wall-clock time, and yield to the event loop
    // between phases. Without the yields the whole batch holds the Node loop
    // for tens of seconds and every HTTP request queues behind it. The three
    // heaviest panels (entryTimeMatrix, exitSimMatrix, walletRepAnalysis) are
    // gated behind HEAVY_PANELS_ENABLED — see the constant comment.
    const timings: Record<string, number> = { computeBestCombos: bestCombosMs };
    // `fn` may return a sync value or a Promise — we await either way so the
    // measured wall-clock includes the full async resolution. Several of the
    // panel computes (panel11, sniperPanel, walletRepAnalysis, entryTimeMatrix,
    // exitSimMatrix) are async because they internally yield to the event loop
    // every ~50 simulateCombo iterations to avoid blocking T+30 deadline timers
    // in the price collector. See yieldEventLoop comment in aggregates.ts.
    const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const result = await fn();
      timings[name] = Date.now() - t0;
      await yieldEventLoop();
      return result;
    };

    const panel11 = await timed('panel11', () => computePanel11(this.db));
    const panel3 = await timed('panel3', () => computePanel3Summary(this.db));
    const pricePathStats = await timed('pricePathStats', () => computePricePathStats(this.db));
    const peakAnalysis = await timed('peakAnalysis', () => computePeakAnalysis(this.db));
    const exitSim = await timed('exitSim', () => computeExitSim(this.db));
    const sniperPanel = await timed('sniperPanel', () => computeSniperPanel(this.db));
    const strategyPercentiles = await timed('strategyPercentiles', () => computeStrategyPercentiles(this.db));
    // Trading-page research panels — all are O(strategies × trades) at most;
    // none touch graduation_momentum × the grid except `counterfactual`, which
    // yields between filters internally.
    const journal = await timed('journal', () => computeJournal(this.db));
    const edgeDecay = await timed('edgeDecay', () => computeEdgeDecay(this.db));
    const counterfactual = await timed('counterfactual', () => computeCounterfactual(this.db));
    const lossPostmortem = await timed('lossPostmortem', () => computeLossPostmortem(this.db));

    const exitSimMatrix = HEAVY_PANELS_ENABLED
      ? await timed('exitSimMatrix', () => computeExitSimMatrix(this.db))
      : disabledPanelStub('exit-sim-matrix');
    const entryTimeMatrix = HEAVY_PANELS_ENABLED
      ? await timed('entryTimeMatrix', () => computeEntryTimeMatrix(this.db))
      : disabledPanelStub('entry-time-matrix');
    const walletRepAnalysis = HEAVY_PANELS_ENABLED
      ? await timed('walletRepAnalysis', () => computeWalletRepAnalysis(this.db))
      : disabledPanelStub('wallet-rep-analysis');

    logger.debug({ bestCombosMs, ...timings, heavyEnabled: HEAVY_PANELS_ENABLED }, 'Sync compute timings');

    // ── Diagnostics: per-step compute timings + event-loop lag ──
    // Sum of all main-thread compute steps. If this exceeds ~5000ms regularly,
    // that's how long the bot is frozen — which directly explains T+30 timer
    // drift observed in directPriceCollector.lastT30Timeouts. Ranked desc so
    // the worst offender surfaces first when reading snapshot.json.
    // `timings` already includes computeBestCombos (seeded from bestCombosMs)
    // plus everything wrapped by `timed()` above. Heavy panels gated behind
    // HEAVY_PANELS_ENABLED only contribute when enabled.
    const totalMainThreadBlockMs = Object.values(timings).reduce((a, b) => a + b, 0);
    const computeTimingsMsRanked: Record<string, number> = Object.fromEntries(
      Object.entries(timings).sort(([, a], [, b]) => b - a)
    );
    const eventLoopLag = getEventLoopLagStats();

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
      listener_dedupe: { verified, recorded, dupe_pct: dupePct },
      rpc_limiter: rpcLimiter,
      // Mirror the trade-pipeline watchdog up to snapshot.json so a glance at
      // bot-status tells the operator whether trades are flowing without
      // having to cross-reference diagnose.json. See diagnose.PipelineHealth
      // for verdict semantics.
      pipeline_health: diagnose.pipeline_health,
      // Event-loop lag (sampled at 1Hz, 10-min ring buffer). p50 should be
      // 0-10 ms in a healthy loop; p95 >100ms means hot-path sync work is
      // intermittently freezing the loop; max_ms_in_window > 1000 ties
      // directly to the T+30 timer drift pattern.
      event_loop_lag: eventLoopLag,
      // Per-step durations of this gist-sync cycle's main-thread compute.
      // Sorted descending so the heaviest step is on top. total_main_thread_block_ms
      // is the cumulative freeze duration; tally it against event_loop_lag.max_ms_in_window
      // to confirm gist-sync is the source.
      gist_sync_compute_ms: {
        total_main_thread_block_ms: totalMainThreadBlockMs,
        per_step: computeTimingsMsRanked,
      },
      recent_graduations: recent,
      last_error: lastError,
    };

    // Heavy compute (filter-v2 panels, price-path detail, trading data) is
    // cached with a 24h TTL — computeFilterV2Data alone is ~100s at current
    // data volume, and running it every 2-min sync was blocking the Node
    // event loop long enough to 502 live dashboard requests. Cache refreshes
    // on boot (first call) and at most once/day after that. Each sync cycle
    // still re-publishes the cached JSON strings so all files stay on
    // bot-status.
    const heavy = await getHeavyData(this.db, this.strategyManager);
    const v2 = heavy.v2;
    const pricePathDetail = heavy.pricePathDetail;
    // Don't reuse heavy.tradingData — strategies/config can drift from what
    // was captured at the last heavy cache refresh (up to 24h old). Recompute
    // fresh each sync cycle so trading.json on bot-status reflects live
    // strategy state. The queries inside computeTradingData are all <100ms.
    const tradingData = computeTradingData(this.db, this.strategyManager, {
      topPairs: v2.panel6.top_pairs,
    });
    const liveExecutionStats = computeLiveExecutionStats(this.db);

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
      'exit-sim-matrix.json': JSON.stringify(exitSimMatrix, null, 2),
      'entry-time-matrix.json': JSON.stringify(entryTimeMatrix, null, 2),
      'wallet-rep-analysis.json': JSON.stringify(walletRepAnalysis, null, 2),
      'sniper-panel.json': JSON.stringify(sniperPanel, null, 2),
      'strategy-percentiles.json': JSON.stringify(strategyPercentiles, null, 2),
      'journal.json': JSON.stringify(journal, null, 2),
      'edge-decay.json': JSON.stringify(edgeDecay, null, 2),
      'counterfactual.json': JSON.stringify(counterfactual, null, 2),
      'loss-postmortem.json': JSON.stringify(lossPostmortem, null, 2),
      'strategies.json': JSON.stringify({
        generated_at: genAt,
        count: strategies.length,
        strategies,
      }, null, 2),
      // Per-command outcomes from the last 20 strategy-commands.json batches
      // the bot processed. Use to debug silently-rejected upserts (ID length
      // violations, invalid params, missing fields). Fresh push wipes the
      // file from main but leaves the entry here.
      'command-results.json': JSON.stringify({
        generated_at: genAt,
        batch_count: this.recentCommandBatches.length,
        batches: this.recentCommandBatches,
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
      // ── v3 panels ──
      'panelv3_1.json': JSON.stringify({ generated_at: genAt, panelv3_1: v2.panelv3_1 }, null, 2),
      'panelv3_2.json': JSON.stringify({ generated_at: genAt, panelv3_2: v2.panelv3_2 }, null, 2),
      'panelv3_3.json': JSON.stringify({ generated_at: genAt, panelv3_3: v2.panelv3_3 }, null, 2),
      'panelv3_4.json': JSON.stringify({ generated_at: genAt, panelv3_4: v2.panelv3_4 }, null, 2),
      'panelv3_5.json': JSON.stringify({ generated_at: genAt, panelv3_5: v2.panelv3_5 }, null, 2),
      'panelv3_6.json': JSON.stringify({ generated_at: genAt, panelv3_6: v2.panelv3_6 }, null, 2),
      'panelv3_7.json': JSON.stringify({ generated_at: genAt, panelv3_7: v2.panelv3_7 }, null, 2),
      'panelv3_8.json': JSON.stringify({ generated_at: genAt, panelv3_8: v2.panelv3_8 }, null, 2),
      'price-path-detail.json': JSON.stringify(pricePathDetail, null, 2),
      'trading.json': JSON.stringify(tradingData, null, 2),
      'live-execution.json': JSON.stringify(liveExecutionStats, null, 2),
    };
  }

  /**
   * fetch() with retry on transient network failures (TypeError "fetch failed",
   * ETIMEDOUT, etc.) AND on 5xx responses. Up to 3 attempts with exponential
   * backoff (1s, 2s, 4s). 4xx responses are returned as-is — those are caller
   * bugs, not transient.
   *
   * Without this, a single GitHub network blip aborted the whole 2-min sync
   * cycle (dropping 25+ JSON files) and logged a full TypeError stack each
   * time, flooding Railway logs.
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
          // Transient server-side error — retry.
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
   * Core sync: process inbound commands, build status payloads, push to bot-status.
   */
  private async sync(): Promise<void> {
    // Process any inbound strategy commands before building status
    await this.processInboundCommands();

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

      // Recovery from a previous outage — log once when we transition back.
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
      // First failure logs at error (with stack) so the cause is visible. Repeat
      // failures degrade to a single warn line so Railway logs stay readable.
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
