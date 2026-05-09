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
import type { StrategyManager } from '../trading/strategy-manager';
import type { LogBuffer } from '../utils/log-buffer';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { vaultPriceCacheStats } from '../trading/executor';
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
  getStrategyManager?: () => StrategyManager | null;
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
  // Runs the CLAUDE.md Level 1-4 bug triage and returns a verdict.
  app.get('/api/diagnose', wrap((_req, res) => {
    const report = runDiagnosis(db, logBuffer);
    res.json(report);
  }));

  // ── /api/snapshot ──
  // One-call summary: counts, scorecard, data quality, last graduation,
  // last crash, recent graduations. This is the "what's going on" endpoint.
  app.get('/api/snapshot', wrap((_req, res) => {
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

  // ── /api/panel3 ──
  // Single-filter regime stability — same as Panel 3 on /filter-analysis-v2 as JSON.
  app.get('/api/panel3', wrap((_req, res) => {
    res.json(computePanel3Summary(db));
  }));

  // ── /api/panel11 ──
  // Combo filter regime stability — same data as Panel 11 on /filter-analysis-v2
  // but as JSON for Claude self-serve. Includes sim return + beats_baseline from
  // best-combos alongside regime bucket data.
  app.get('/api/panel11', wrap((_req, res) => {
    res.json(computePanel11(db));
  }));

  // ── /api/price-path-stats ──
  // Aggregated price path statistics: mean paths by label, Cohen's d feature effects,
  // entry timing optimization, velocity breakdown. Compact — no raw token rows.
  app.get('/api/price-path-stats', wrap((_req, res) => {
    res.json(computePricePathStats(db));
  }));

  // ── /api/peak-analysis ──
  // Diagnostic data for max_relret_0_300 (look-ahead peak from T+30 entry).
  // CDF, peak-time histogram, per-filter peak-bucket table, suggested TP.
  // NOT a tradable filter — kept off /api/best-combos by design.
  app.get('/api/peak-analysis', wrap((_req, res) => {
    res.json(computePeakAnalysis(db));
  }));

  // ── /api/markov-matrix ──
  // State-conditional exit DPM matrix per registered strategy filter set.
  // Each cell = P(profit at T+300 | filter, age, current_pct_from_entry bucket).
  // Built from labeled paths every REFIT_PATHS_THRESHOLD new closures.
  // Returns 404 until the strategy manager finishes initializing.
  app.get('/api/markov-matrix', wrap((_req, res) => {
    const sm = getStrategyManager?.() ?? null;
    if (!sm) {
      res.status(404).json({ error: 'StrategyManager not initialized yet' });
      return;
    }
    res.json(sm.getMarkovStore().toJson());
  }));

  // ── /api/filter-catalog ──
  // The filter definitions used by /api/best-combos. Useful for Claude to
  // enumerate the search space before proposing new candidates.
  app.get('/api/filter-catalog', wrap((_req, res) => {
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
