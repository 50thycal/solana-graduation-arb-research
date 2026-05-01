/**
 * src/api/routes.ts
 *
 * JSON-first self-service API for the research bot. Every endpoint here is
 * GET-only and read-only — safe to hit from WebFetch without auth. The goal
 * is that Claude can call `/api/diagnose` + `/api/snapshot` + `/api/best-combos`
 * at the start of every session and have everything it needs to pick the
 * next hypothesis without asking the human.
 *
 * Endpoints:
 *   GET /api/diagnose         — Level 1-4 bug triage verdict
 *   GET /api/snapshot         — one-call dashboard summary
 *   GET /api/best-combos      — filter leaderboard ranked by simulated EV
 *   GET /api/trades           — recent trades (query: ?limit=&status=)
 *   GET /api/skips            — recent skipped candidates
 *   GET /api/graduations      — recent graduations (query: ?limit=&label=)
 *   GET /api/logs             — in-process log ring buffer
 *   GET /api/filter-catalog   — the filter definitions /api/best-combos uses
 *   GET /api/bot-errors       — recent uncaught errors
 *
 * Handlers are thin: they call aggregates.ts / diagnose.ts / queries.ts
 * and return the result. Any computation belongs in the called module,
 * not here.
 */

import type { Application, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import {
  computeThesisScorecard,
  computeDataQualityFlags,
  computeRecentGraduationsEnriched,
  computeBestCombos,
  FILTER_CATALOG,
} from './aggregates';
import { runDiagnosis } from './diagnose';
import { computePanel11 } from './panel11';
import { computePanel3Summary } from './panel3-summary';
import { computePricePathStats } from './price-path-stats';
import { computePeakAnalysis } from './peak-analysis';
import { computeExitSim } from './exit-sim';
import { computeExitSimMatrix } from './exit-sim-matrix';
import { computeWalletRepAnalysis } from './wallet-rep-analysis';
import { computeSniperPanel } from './sniper-panel';
import { computeFilterV2Data } from './filter-v2-data';
import { computeTradingData } from './trading-data';
import { computeLiveExecutionStats } from './live-execution-stats';
import { verifyPumpswapSwap, findRecentPumpSwapCandidates } from '../trading/pumpswap-verify';
import { Connection } from '@solana/web3.js';
import { getHeavyData } from './heavy-cache';
import type { LogBuffer } from '../utils/log-buffer';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { vaultPriceCacheStats } from '../trading/executor';
import type { StrategyManager } from '../trading/strategy-manager';
import {
  getGraduationCount,
  getRecentTrades,
  getOpenTrades,
  getRecentSkips,
  getSkipReasonCounts,
  getTradeStats,
  getTradeStatsByStrategy,
  getLastBotError,
  getRecentBotErrors,
} from '../db/queries';

export interface RegisterApiOptions {
  app: Application;
  db: Database.Database;
  logBuffer: LogBuffer;
  startTime: number;
  getListenerStats?: () => unknown;
  /**
   * StrategyManager is constructed lazily (only when trading is enabled),
   * so route handlers need a getter rather than a direct reference. Returns
   * null when trading is disabled or before initialization.
   */
  getStrategyManager?: () => StrategyManager | null;
}

/** HTML escape for embedding strings inside <pre>. Pubkeys are base58 so they're
 * safe, but error messages may contain anything. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Browser-friendly wrapper for the verify-pumpswap report. Includes a copy-all
 * button, a matched/mismatched badge derived from the payload, and the JSON in
 * a wrap-friendly <pre>. Kept inline (no template engine) — single endpoint. */
function renderVerifyHtml(payload: unknown, prettyJson: string): string {
  const p = payload as { matched?: boolean; notes?: string; error?: string };
  const matched = p?.matched === true;
  const errored = typeof p?.error === 'string';
  const badge = errored
    ? { label: 'ERROR', cls: 'err' }
    : matched
    ? { label: 'MATCHED', cls: 'ok' }
    : { label: 'MISMATCH', cls: 'bad' };
  const notes = p?.notes ?? p?.error ?? '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>verify-pumpswap</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:0;padding:14px;background:#1e1e1e;color:#d4d4d4}
  .bar{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
  button{font:inherit;padding:6px 14px;cursor:pointer;background:#2d2d2d;color:#d4d4d4;border:1px solid #555;border-radius:4px}
  button:hover{background:#3a3a3a}
  .badge{padding:3px 9px;border-radius:4px;font-weight:700;font-size:12px;letter-spacing:0.5px}
  .ok{background:#1f6f1f;color:#fff}
  .bad{background:#b04040;color:#fff}
  .err{background:#7a5a1a;color:#fff}
  .notes{color:#aaa;font-size:13px}
  pre{white-space:pre-wrap;word-break:break-all;margin:0;padding:10px;background:#252525;border:1px solid #333;border-radius:4px}
</style></head><body>
<div class="bar">
  <button id="cp">Copy all</button>
  <span class="badge ${badge.cls}">${badge.label}</span>
  <span class="notes">${escapeHtml(notes)}</span>
</div>
<pre id="payload">${escapeHtml(prettyJson)}</pre>
<script>
  document.getElementById('cp').addEventListener('click', function(){
    var btn = this;
    navigator.clipboard.writeText(document.getElementById('payload').textContent).then(function(){
      btn.textContent = '✓ Copied';
      setTimeout(function(){ btn.textContent = 'Copy all'; }, 1500);
    });
  });
</script>
</body></html>`;
}

export function registerApiRoutes(opts: RegisterApiOptions): void {
  const { app, db, logBuffer, startTime, getListenerStats, getStrategyManager } = opts;

  // Small helper — consistent error envelope.
  const wrap = (
    handler: (req: Request, res: Response) => void | Promise<void>,
  ) => {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    };
  };

  // ── /api/diagnose ──
  // Runs the CLAUDE.md Level 1-5 bug triage and returns a verdict, plus a
  // pipeline_health watchdog block that surfaces stalled paper/shadow trade
  // flow (WS down, T+30 callbacks silent, no recent entries).
  app.get('/api/diagnose', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    let wsConnected: boolean | null = null;
    if (getListenerStats) {
      try {
        const stats = getListenerStats() as { wsConnected?: boolean } | null;
        if (stats && typeof stats.wsConnected === 'boolean') wsConnected = stats.wsConnected;
      } catch { /* listener may not be initialized yet */ }
    }
    const report = runDiagnosis(db, logBuffer, {
      wsConnected,
      lastT30CallbackAt: sm?.getLastT30CallbackAt() ?? null,
      enabledStrategies: sm ? sm.getStrategies().filter(s => s.enabled).length : 0,
    });
    res.json(report);
  }));

  // ── /api/live-execution-stats ──
  // Live-mode execution health: tx land rate, latency, Jito spend, measured
  // vs assumed slippage. Claude reads this to decide rollout-phase promotion.
  app.get('/api/live-execution-stats', wrap(async (_req, res) => {
    res.json(computeLiveExecutionStats(db));
  }));

  // ── /api/verify-pumpswap ──
  // Simulation gate: rebuild a swap with @pump-fun/pump-swap-sdk (the same
  // builder the executor uses), wrap it in a v0 tx, and run simulateTransaction
  // against the current chain. Source amounts + user wallet from a real
  // recent on-chain swap so the user has funds at sim time — the only thing
  // being tested is whether the SDK ix is accepted by the on-chain program.
  //   GET /api/verify-pumpswap                 → auto-picks the most recent
  //                                              swap on a freshly-graduated
  //                                              pool from the bot's DB
  //   GET /api/verify-pumpswap?sig=<txSig>     → simulates the SDK rebuild
  //                                              of that specific tx
  //   GET /api/verify-pumpswap?sig=...&ixIndex=N → N-th ix in that tx
  //   GET /api/verify-pumpswap?...&pretty=1    → 2-space indented JSON
  //
  // Browser default (Accept: text/html) is an HTML page with the JSON in a
  // <pre> + a Copy-all button + matched/mismatched badge — convenient when
  // pasting findings into chat. Curl / fetch get JSON.
  app.get('/api/verify-pumpswap', wrap(async (req, res) => {
    const wantsHtml = req.accepts(['html', 'json']) === 'html';
    const pretty = wantsHtml || req.query.pretty === '1' || req.query.pretty === 'true';
    const send = (status: number, payload: unknown) => {
      const json = JSON.stringify(payload, null, pretty ? 2 : 0);
      if (wantsHtml) {
        res.status(status).type('text/html').send(renderVerifyHtml(payload, json));
      } else {
        res.status(status).type('application/json').send(json);
      }
    };

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      send(500, { error: 'HELIUS_RPC_URL not set on server' });
      return;
    }
    const connection = new Connection(rpcUrl, 'confirmed');

    const explicitSig = String(req.query.sig ?? '').trim();
    const explicitIxIndex = req.query.ixIndex != null && req.query.ixIndex !== ''
      ? parseInt(String(req.query.ixIndex), 10)
      : undefined;

    // Caller-supplied sig: single attempt, surface whatever the sim returns.
    if (explicitSig) {
      try {
        const report = await verifyPumpswapSwap(connection, explicitSig, { ixIndex: explicitIxIndex });
        send(report.matched ? 200 : 409, { ...report, autoPicked: null, attempts: 1 });
      } catch (err) {
        send(502, {
          error: err instanceof Error ? err.message : String(err),
          sig: explicitSig, ixIndex: explicitIxIndex, autoPicked: null,
        });
      }
      return;
    }

    // Auto-pick path: collect up to 5 candidates (buys first, sell fallback)
    // and try each until one simulates green. Historical user wallets drift
    // (drained SOL, closed ATAs); single-shot was 50/50 on greens. Returning
    // the first green keeps the endpoint a useful pre-shadow gate; if all
    // tries are red, returns the last attempt + the count for context.
    let candidates;
    try {
      candidates = await findRecentPumpSwapCandidates(connection, db, 5);
    } catch (err) {
      send(502, {
        error: 'auto-pick failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (candidates.length === 0) {
      send(404, {
        error: 'no recent PumpSwap swap found in last 5 graduated pools',
        hint: 'pass ?sig=<txSignature> explicitly, or wait for new graduations',
      });
      return;
    }

    let lastReport: Awaited<ReturnType<typeof verifyPumpswapSwap>> | null = null;
    let lastAutoPicked: { poolAddress: string; direction: 'buy' | 'sell' } | null = null;
    let attempts = 0;
    for (const pick of candidates) {
      attempts++;
      try {
        const report = await verifyPumpswapSwap(connection, pick.sig, { ixIndex: pick.ixIndex });
        lastReport = report;
        lastAutoPicked = { poolAddress: pick.poolAddress, direction: pick.direction };
        if (report.matched) break;
      } catch (err) {
        // Per-candidate fetch/decode failure — skip this one, try the next.
        // Only fall through to the 502 path if we exhaust everything.
        if (attempts === candidates.length && lastReport === null) {
          send(502, {
            error: err instanceof Error ? err.message : String(err),
            sig: pick.sig, ixIndex: pick.ixIndex, autoPicked: lastAutoPicked,
          });
          return;
        }
      }
    }

    if (!lastReport) {
      send(502, {
        error: 'all auto-picked candidates failed to fetch/decode',
        attempts,
      });
      return;
    }
    send(lastReport.matched ? 200 : 409, { ...lastReport, autoPicked: lastAutoPicked, attempts });
  }));

  // ── /api/snapshot ──
  // One-call summary: counts, scorecard, data quality, last graduation,
  // last crash, recent graduations. This is the "what's going on" endpoint.
  app.get('/api/snapshot', wrap(async (_req, res) => {
    const nowMs = Date.now();
    const uptimeSec = Math.floor((nowMs - startTime) / 1000);

    const scorecard = computeThesisScorecard(db);
    const quality = computeDataQualityFlags(db);
    const recent = computeRecentGraduationsEnriched(db, 10);

    const listenerStats = getListenerStats ? getListenerStats() : null;
    const lastError = getLastBotError(db);

    res.json({
      generated_at: new Date(nowMs).toISOString(),
      uptime_sec: uptimeSec,
      counts: {
        graduations: getGraduationCount(db),
        momentum_labeled: scorecard.total_labeled,
        pump: scorecard.PUMP,
        dump: scorecard.DUMP,
        stable: scorecard.STABLE,
        unlabeled: scorecard.unlabeled,
      },
      scorecard,
      data_quality: quality,
      listener: listenerStats,
      rpc: {
        limiter: globalRpcLimiter.getStats(),
        vault_price_cache: { ...vaultPriceCacheStats },
      },
      recent_graduations: recent,
      last_error: lastError,
    });
  }));

  // ── /api/best-combos ──
  // Ranked leaderboard of single filters and cross-group pairs, sorted by
  // 10%SL/50%TP simulated avg return. This is the endpoint that lets Claude
  // discover profitable filters without being told which to look at.
  app.get('/api/best-combos', wrap((req, res) => {
    const minN = parseInt(String(req.query.min_n ?? '20'), 10);
    const top = parseInt(String(req.query.top ?? '20'), 10);
    const includePairs = String(req.query.pairs ?? 'true') !== 'false';
    const leaderboard = computeBestCombos(db, {
      min_n: Number.isFinite(minN) ? minN : 20,
      top: Number.isFinite(top) ? top : 20,
      include_pairs: includePairs,
    });
    res.json(leaderboard);
  }));

  // ── /api/wallet-rep-analysis ──
  // Top 20 combos × creator-wallet-rep filters: matrix of sim-return deltas
  // and a "best rep filter overall" summary. Reuses simulateCombo() from
  // aggregates.ts so the cost/gap model matches /api/best-combos exactly.
  app.get('/api/wallet-rep-analysis', wrap(async (_req, res) => {
    res.json(computeWalletRepAnalysis(db));
  }));

  // ── /api/sniper-panel ──
  // Sniper-window analytics: threshold sweeps + histograms for
  // sniper_count_t0_t2 and sniper_wallet_velocity_avg, plus the slice of
  // /api/best-combos rows that include a sniper filter. Same simulateCombo()
  // cost model as /api/best-combos so per-combo opt TP/SL are comparable.
  app.get('/api/sniper-panel', wrap(async (_req, res) => {
    res.json(computeSniperPanel(db));
  }));

  // ── /api/panel3 ──
  // Single-filter regime stability — same as Panel 3 on /filter-analysis-v2 as JSON.
  app.get('/api/panel3', wrap(async (_req, res) => {
    res.json(computePanel3Summary(db));
  }));

  // ── /api/panel11 ──
  // Combo filter regime stability — same data as Panel 11 on /filter-analysis-v2
  // but as JSON for Claude self-serve. Includes sim return + beats_baseline from
  // best-combos alongside regime bucket data.
  app.get('/api/panel11', wrap(async (_req, res) => {
    res.json(computePanel11(db));
  }));

  // ── /api/price-path-stats ──
  // Aggregated price path statistics: mean paths by label, Cohen's d feature effects,
  // entry timing optimization, velocity breakdown. Compact — no raw token rows.
  app.get('/api/price-path-stats', wrap(async (_req, res) => {
    res.json(computePricePathStats(db));
  }));

  // ── /api/filter-v2 ──
  // Full FilterV2Data object (all 11 panels) — the same payload that backs
  // /filter-analysis-v2 and the bot-status sync. Use /api/panelN for a slice.
  // Served from the shared 24h heavy cache (src/api/heavy-cache.ts); the
  // `?p6=` power-user slice bypasses the cache since it depends on URL input.
  app.get('/api/filter-v2', wrap(async (req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const data = req.query.p6 !== undefined
      ? await computeFilterV2Data(db, { p6Raw: req.query.p6 })
      : (await getHeavyData(db, sm)).v2;
    res.json(data);
  }));

  // ── /api/panel1 .. /api/panel10 ──
  // Per-panel slices of FilterV2Data — all served from the 24h heavy cache.
  app.get('/api/panel1', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({
      generated_at: d.generated_at,
      panel1: d.panel1,
      panel1_t60: d.panel1_t60,
      panel1_t120: d.panel1_t120,
    });
  }));
  app.get('/api/panel2', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel2: d.panel2 });
  }));
  app.get('/api/panel4', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({
      generated_at: d.generated_at,
      panel4: d.panel4,
      panel4_t60: d.panel4_t60,
      panel4_t120: d.panel4_t120,
    });
  }));
  app.get('/api/panel5', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel5: d.panel5 });
  }));
  app.get('/api/panel6', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    // Expose only the static auto-scanned leaderboard; the URL-driven "dynamic"
    // slice requires user selection and is skipped in the JSON view.
    res.json({
      generated_at: d.generated_at,
      panel6: {
        title: d.panel6.title,
        description: d.panel6.description,
        filter_names: d.panel6.filter_names,
        top_pairs: d.panel6.top_pairs,
        top_pairs_t60: d.panel6.top_pairs_t60,
        top_pairs_t120: d.panel6.top_pairs_t120,
        flags: d.panel6.flags,
      },
    });
  }));
  app.get('/api/panel7', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel7: d.panel7 });
  }));
  app.get('/api/panel8', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel8: d.panel8 });
  }));
  app.get('/api/panel9', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel9: d.panel9 });
  }));
  app.get('/api/panel10', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panel10: d.panel10 });
  }));

  // ── /api/filter-v3 ──
  // Six v3 panels (triple-filter combos, drawdown-gate stacking, crash-survival
  // curves, max_tick_drop, velocity × liquidity heatmap, sum_abs_returns).
  // Same 24h heavy cache as the v2 panels.
  app.get('/api/filter-v3', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({
      generated_at: d.generated_at,
      panelv3_1: d.panelv3_1,
      panelv3_2: d.panelv3_2,
      panelv3_3: d.panelv3_3,
      panelv3_4: d.panelv3_4,
      panelv3_5: d.panelv3_5,
      panelv3_6: d.panelv3_6,
      panelv3_7: d.panelv3_7,
    });
  }));

  // Per-panel v3 slices.
  app.get('/api/panelv3_1', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_1: d.panelv3_1 });
  }));
  app.get('/api/panelv3_2', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_2: d.panelv3_2 });
  }));
  app.get('/api/panelv3_3', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_3: d.panelv3_3 });
  }));
  app.get('/api/panelv3_4', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_4: d.panelv3_4 });
  }));
  app.get('/api/panelv3_5', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_5: d.panelv3_5 });
  }));
  app.get('/api/panelv3_6', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_6: d.panelv3_6 });
  }));
  app.get('/api/panelv3_7', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const d = (await getHeavyData(db, sm)).v2;
    res.json({ generated_at: d.generated_at, panelv3_7: d.panelv3_7 });
  }));

  // ── /api/price-path-detail ──
  // Full price-path dashboard data: overlay (≤200 raw token paths), mean paths
  // by label with ±1 SD, vel 5-20 vs all, derived metrics (Cohen's d),
  // acceleration histogram, entry timing heatmap, monotonicity buckets.
  // Served from the 24h heavy cache.
  app.get('/api/price-path-detail', wrap(async (_req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    res.json((await getHeavyData(db, sm)).pricePathDetail);
  }));

  // ── /api/trading ──
  // Full /trading dashboard data: open positions, per-strategy performance,
  // recent trades (50), skip reasons + recent skips, active strategy configs.
  app.get('/api/trading', wrap((req, res) => {
    const sm = getStrategyManager ? getStrategyManager() : null;
    const data = computeTradingData(db, sm, {
      strategyFilter: (req.query.strategy as string) || '',
    });
    res.json(data);
  }));

  // ── /api/peak-analysis ──
  // Diagnostic data for max_relret_0_300 (look-ahead peak from T+30 entry).
  // CDF, peak-time histogram, per-filter peak-bucket table, suggested TP.
  // NOT a tradable filter — kept off /api/best-combos by design.
  app.get('/api/peak-analysis', wrap(async (_req, res) => {
    res.json(computePeakAnalysis(db));
  }));

  // ── /api/exit-sim ──
  // Dynamic-exit strategy simulator. Evaluates alternative exit logic
  // (momentum reversal today; scale-out, vol-trail, time-decayed TP in
  // follow-ups) against the baseline 10%SL/50%TP on a filter universe.
  // Default universe = vel<20 + top5<10% (current +6.44% baseline).
  app.get('/api/exit-sim', wrap(async (_req, res) => {
    res.json(computeExitSim(db));
  }));

  // ── /api/exit-sim-matrix ──
  // Cross-combo view: re-runs the full 5-strategy grid against each of the
  // top 20 filter combos and surfaces the best-cell-per-strategy + Δ vs the
  // combo's own static 10%SL/50%TP baseline. Sorted by best delta so the
  // combos that gain the most from dynamic exits surface first.
  app.get('/api/exit-sim-matrix', wrap(async (_req, res) => {
    res.json(computeExitSimMatrix(db));
  }));

  // ── /api/filter-catalog ──
  // The filter definitions used by /api/best-combos. Useful for Claude to
  // enumerate the search space before proposing new candidates.
  app.get('/api/filter-catalog', wrap(async (_req, res) => {
    res.json({
      count: FILTER_CATALOG.length,
      filters: FILTER_CATALOG,
    });
  }));

  // ── /api/trades ──
  app.get('/api/trades', wrap((req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    const status = String(req.query.status ?? 'all');

    let trades: unknown[];
    if (status === 'open') {
      trades = getOpenTrades(db);
    } else {
      const recent = getRecentTrades(db, limit) as Array<Record<string, unknown>>;
      trades = status === 'closed'
        ? recent.filter((t) => t.status === 'closed')
        : recent;
    }

    res.json({
      generated_at: new Date().toISOString(),
      stats: getTradeStats(db),
      by_strategy: getTradeStatsByStrategy(db),
      count: trades.length,
      trades,
    });
  }));

  // ── /api/skips ──
  app.get('/api/skips', wrap((req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    res.json({
      generated_at: new Date().toISOString(),
      reason_counts: getSkipReasonCounts(db),
      count: limit,
      skips: getRecentSkips(db, limit),
    });
  }));

  // ── /api/graduations ──
  // JSON variant of /tokens. Supports label and velocity filters; the
  // filters are all parameter-bound so raw user input can't leak into SQL.
  app.get('/api/graduations', wrap((req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    const label = String(req.query.label ?? '');
    const velMinRaw = req.query.vel_min != null ? Number(req.query.vel_min) : null;
    const velMaxRaw = req.query.vel_max != null ? Number(req.query.vel_max) : null;
    const velMin = velMinRaw !== null && Number.isFinite(velMinRaw) ? velMinRaw : null;
    const velMax = velMaxRaw !== null && Number.isFinite(velMaxRaw) ? velMaxRaw : null;

    const where: string[] = [];
    const params: unknown[] = [];
    if (label === 'PUMP' || label === 'DUMP' || label === 'STABLE') {
      where.push('m.label = ?');
      params.push(label);
    }
    if (velMin !== null) {
      where.push('m.bc_velocity_sol_per_min >= ?');
      params.push(velMin);
    }
    if (velMax !== null) {
      where.push('m.bc_velocity_sol_per_min < ?');
      params.push(velMax);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit);
    const rows = db.prepare(`
      SELECT
        m.graduation_id as id,
        g.mint,
        m.open_price_sol,
        m.pct_t30,
        m.pct_t60,
        m.pct_t300,
        m.label,
        m.holder_count,
        m.top5_wallet_pct,
        m.dev_wallet_pct,
        m.token_age_seconds,
        m.bc_velocity_sol_per_min,
        m.total_sol_raised,
        m.liquidity_sol_t30,
        g.new_pool_address,
        g.timestamp as graduation_ts
      FROM graduation_momentum m
      JOIN graduations g ON g.id = m.graduation_id
      ${whereSql}
      ORDER BY m.graduation_id DESC
      LIMIT ?
    `).all(...params);

    res.json({
      generated_at: new Date().toISOString(),
      count: rows.length,
      filters_applied: { label: label || null, vel_min: velMin, vel_max: velMax },
      rows,
    });
  }));

  // ── /api/logs ──
  app.get('/api/logs', wrap((req, res) => {
    const level = req.query.level ? String(req.query.level) : undefined;
    const grep = req.query.grep ? String(req.query.grep) : undefined;
    const sinceRaw = req.query.since != null ? Number(req.query.since) : null;
    const since = sinceRaw !== null && Number.isFinite(sinceRaw) ? sinceRaw : undefined;
    const limit = Math.min(2000, parseInt(String(req.query.limit ?? '500'), 10) || 500);

    const entries = logBuffer.query({ level, grep, since, limit });
    res.json({
      generated_at: new Date().toISOString(),
      count: entries.length,
      buffer_size: logBuffer.size(),
      filters_applied: { level: level ?? null, grep: grep ?? null, since: since ?? null },
      entries,
    });
  }));

  // ── /api/bot-errors ──
  app.get('/api/bot-errors', wrap((req, res) => {
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20);
    res.json({
      generated_at: new Date().toISOString(),
      last_error: getLastBotError(db),
      recent: getRecentBotErrors(db, limit),
    });
  }));

  // ── /api ── (index listing endpoints for discovery)
  app.get('/api', (_req: Request, res: Response) => {
    res.json({
      service: 'solana-graduation-arb-research',
      version: 1,
      endpoints: [
        { path: '/api/diagnose',           description: 'Level 1-4 bug triage verdict' },
        { path: '/api/snapshot',           description: 'One-call dashboard summary' },
        { path: '/api/best-combos',        description: 'Filter leaderboard ranked by simulated EV' },
        { path: '/api/panel3',             description: 'Single-filter regime stability JSON (same as Panel 3 on /filter-analysis-v2)' },
        { path: '/api/panel11',            description: 'Combo regime stability JSON (same as Panel 11 on /filter-analysis-v2)' },
        { path: '/api/price-path-stats',   description: 'Aggregated price path stats: mean paths by label, Cohen\'s d, entry timing' },
        { path: '/api/price-path-detail',  description: 'Full /price-path data: overlay (200 tokens), mean paths ±1 SD, Cohen\'s d, histograms, entry timing heatmap, monotonicity buckets' },
        { path: '/api/filter-v2',          description: 'Full FilterV2Data (all 11 panels) — same as /filter-analysis-v2' },
        { path: '/api/panel1',             description: 'Panel 1 + T+60/T+120 variants (single-feature filter comparison)' },
        { path: '/api/panel2',             description: 'Panel 2 (T+30-anchored return percentiles: MAE/MFE/Final)' },
        { path: '/api/panel4',             description: 'Panel 4 + T+60/T+120 variants (TP/SL EV simulator)' },
        { path: '/api/panel5',             description: 'Panel 5 (Wilson CI + bootstrap significance)' },
        { path: '/api/panel6',             description: 'Panel 6 (multi-filter intersection, top pairs)' },
        { path: '/api/panel7',             description: 'Panel 7 (walk-forward validation 70/30)' },
        { path: '/api/panel8',             description: 'Panel 8 (loss tail & risk metrics)' },
        { path: '/api/panel9',             description: 'Panel 9 (equity curve & drawdown simulation)' },
        { path: '/api/panel10',            description: 'Panel 10 (DPM optimizer — optima + top-N tail + aggregates)' },
        { path: '/api/filter-v3',          description: 'All 6 v3 panels (triples, dd-gate, survival, tick-drop, heatmap, sum-abs)' },
        { path: '/api/panelv3_1',          description: 'v3 Panel 1 (top 20 three-filter combos, per horizon)' },
        { path: '/api/panelv3_2',          description: 'v3 Panel 2 (max_dd_0_30 gate stacking on best singles/pairs)' },
        { path: '/api/panelv3_3',          description: 'v3 Panel 3 (crash survival curves — time-to-threshold-breach)' },
        { path: '/api/panelv3_4',          description: 'v3 Panel 4 (max_tick_drop_0_30 — new filter dim)' },
        { path: '/api/panelv3_5',          description: 'v3 Panel 5 (velocity × liquidity heatmap)' },
        { path: '/api/panelv3_6',          description: 'v3 Panel 6 (sum_abs_returns_0_30 — pre-entry realized vol)' },
        { path: '/api/panelv3_7',          description: 'v3 Panel 7 (regime + walk-forward on v3 leaders — stability check)' },
        { path: '/api/exit-sim',           description: 'Dynamic-exit strategy simulator (momentum, scale-out, vol-trail, time-decayed TP)' },
        { path: '/api/trading',            description: 'Full /trading data: open positions, performance, trades, skips' },
        { path: '/api/filter-catalog',     description: 'Filter definitions used by best-combos' },
        { path: '/api/trades',         description: 'Recent trades (query: limit, status)' },
        { path: '/api/skips',          description: 'Recent skipped candidates' },
        { path: '/api/graduations',    description: 'Recent graduations (query: limit, label, vel_min, vel_max)' },
        { path: '/api/logs',           description: 'In-process log ring buffer (query: level, since, limit, grep)' },
        { path: '/api/bot-errors',     description: 'Recent uncaught errors' },
      ],
    });
  });
}
