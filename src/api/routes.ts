/**
 * src/api/routes.ts
 *
 * Self-service JSON API under /api/*. Copy-trading-only posture: the
 * graduation-research endpoints (best-combos, panels, exit-sim, regime,
 * wallet-rep, journal, daily-report, etc.) were removed in the refactor. What
 * remains is infra + detection health + the live-execution gate:
 *
 *   /api/diagnose              Level 1-style detection health verdict
 *   /api/snapshot              counts + listener + RPC + last error
 *   /api/live-execution-stats  live-money execution health (copy live_micro)
 *   /api/verify-pumpswap       PumpSwap SDK simulation gate
 *   /api/skips                 recent skipped candidates
 *   /api/graduations           recent detected graduations
 *   /api/logs                  in-process log ring buffer
 *   /api/bot-errors            recent uncaught errors
 *   /api/roast                 LLM commentary for the live dashboard
 *
 * Copy-trade JSON views (copy-trades, wallet-leaderboard, smart-money, etc.)
 * are published to the bot-status branch by gist-sync.ts, not served here.
 */

import type { Application, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { runDiagnosis, type ChannelWinCounts } from './diagnose';
import { handleRoast } from './roast';
import { computeLiveExecutionStats } from './live-execution-stats';
import { verifyPumpswapSwap, findRecentPumpSwapCandidates } from '../trading/pumpswap-verify';
import { Connection } from '@solana/web3.js';
import type { LogBuffer } from '../utils/log-buffer';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { vaultPriceCacheStats } from '../trading/executor';
import {
  getGraduationCount,
  getRecentSkips,
  getSkipReasonCounts,
  getLastBotError,
  getRecentBotErrors,
} from '../db/queries';

export interface RegisterApiOptions {
  app: Application;
  db: Database.Database;
  logBuffer: LogBuffer;
  startTime: number;
  getListenerStats?: () => unknown;
}

/** HTML escape for embedding strings inside <pre>. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Browser-friendly wrapper for the verify-pumpswap report. */
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
  const { app, db, logBuffer, startTime, getListenerStats } = opts;

  // Consistent error envelope.
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

  // Read best-effort listener detection signals (WS health, candidate flow).
  const readListenerSignals = (): {
    wsConnected: boolean | null;
    channelWins: ChannelWinCounts | undefined;
    lastCandidateSecAgo: number | null;
  } => {
    let wsConnected: boolean | null = null;
    let channelWins: ChannelWinCounts | undefined = undefined;
    let lastCandidateSecAgo: number | null = null;
    if (getListenerStats) {
      try {
        const stats = getListenerStats() as {
          wsConnected?: boolean;
          channel_wins?: ChannelWinCounts;
          lastCandidateSecondsAgo?: number;
        } | null;
        if (stats && typeof stats.wsConnected === 'boolean') wsConnected = stats.wsConnected;
        if (stats && stats.channel_wins) channelWins = stats.channel_wins;
        if (stats && typeof stats.lastCandidateSecondsAgo === 'number') {
          lastCandidateSecAgo = stats.lastCandidateSecondsAgo;
        }
      } catch { /* listener may not be initialized yet */ }
    }
    return { wsConnected, channelWins, lastCandidateSecAgo };
  };

  // ── /api/roast ──
  app.post('/api/roast', wrap(handleRoast));

  // ── /api/diagnose ──
  app.get('/api/diagnose', wrap(async (_req, res) => {
    const { wsConnected, channelWins, lastCandidateSecAgo } = readListenerSignals();
    // The graduation-arb StrategyManager was removed — pass neutral trade-pipeline values.
    const report = runDiagnosis(db, logBuffer, {
      wsConnected,
      lastT30CallbackAt: null,
      enabledStrategies: 0,
      channelWins,
      lastCandidateSecAgo,
    });
    res.json(report);
  }));

  // ── /api/live-execution-stats ──
  app.get('/api/live-execution-stats', wrap(async (_req, res) => {
    res.json(computeLiveExecutionStats(db));
  }));

  // ── /api/verify-pumpswap ──
  // Simulation gate: rebuild a swap with @pump-fun/pump-swap-sdk and run
  // simulateTransaction against the current chain.
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
      send(502, { error: 'all auto-picked candidates failed to fetch/decode', attempts });
      return;
    }
    send(lastReport.matched ? 200 : 409, { ...lastReport, autoPicked: lastAutoPicked, attempts });
  }));

  // ── /api/snapshot ──
  app.get('/api/snapshot', wrap(async (_req, res) => {
    const nowMs = Date.now();
    res.json({
      generated_at: new Date(nowMs).toISOString(),
      uptime_sec: Math.floor((nowMs - startTime) / 1000),
      counts: { graduations: getGraduationCount(db) },
      listener: getListenerStats ? getListenerStats() : null,
      rpc: {
        limiter: globalRpcLimiter.getStats(),
        vault_price_cache: { ...vaultPriceCacheStats },
      },
      last_error: getLastBotError(db),
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
  // Recent detected graduations. Price/label columns are NULL in the default
  // enrichment-only mode (set GRADUATION_PRICE_PATH_ENABLED=true to populate).
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
    if (velMin !== null) { where.push('m.bc_velocity_sol_per_min >= ?'); params.push(velMin); }
    if (velMax !== null) { where.push('m.bc_velocity_sol_per_min < ?'); params.push(velMax); }
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

  // ── /api ── (endpoint discovery)
  app.get('/api', (_req: Request, res: Response) => {
    res.json({
      service: 'solana-graduation-arb-research',
      version: 2,
      note: 'copy-trading-only build; copy-trade JSON views are on the bot-status branch',
      endpoints: [
        { path: '/api/diagnose',             description: 'Detection health verdict' },
        { path: '/api/snapshot',             description: 'One-call counts + listener + RPC summary' },
        { path: '/api/live-execution-stats', description: 'Live-money execution health (copy live_micro)' },
        { path: '/api/verify-pumpswap',      description: 'PumpSwap SDK simulation gate' },
        { path: '/api/skips',                description: 'Recent skipped candidates' },
        { path: '/api/graduations',          description: 'Recent detected graduations (query: limit, label, vel_min, vel_max)' },
        { path: '/api/logs',                 description: 'In-process log ring buffer (query: level, since, limit, grep)' },
        { path: '/api/bot-errors',           description: 'Recent uncaught errors' },
      ],
    });
  });
}
