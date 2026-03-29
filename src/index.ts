import express from 'express';
import pino from 'pino';
import { initDatabase } from './db/schema';
import { getGraduationCount } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'main' });

const startTime = Date.now();
let listenerStatus: 'running' | 'stopped' | 'error' = 'stopped';
let listenerError: string | null = null;

async function main() {
  logger.info('Starting solana-graduation-arb-research');

  // Log env var presence for debugging (not values — they contain API keys)
  logger.info({
    hasHeliusRpc: !!process.env.HELIUS_RPC_URL,
    hasHeliusWs: !!process.env.HELIUS_WS_URL,
    dataDir: process.env.DATA_DIR || './data',
    healthPort: process.env.HEALTH_PORT || '8080',
  }, 'Environment check');

  // Initialize database
  const dataDir = process.env.DATA_DIR || './data';
  const db = initDatabase(dataDir);

  // Start health/API server first so we can always debug via /health
  const healthPort = parseInt(process.env.HEALTH_PORT || '8080', 10);
  const app = express();

  // Reset research data — wipes all rows but keeps tables/schema intact
  app.post('/reset', (req, res) => {
    try {
      const tables = [
        'competition_signals',
        'opportunities',
        'price_comparisons',
        'pool_observations',
        'graduation_momentum',
        'graduations',
      ];
      // Delete in dependency order (children first due to foreign keys)
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      res.json({
        status: 'ok',
        message: 'All research data cleared. Schema and tables preserved. Bot will continue collecting fresh data.',
        tables_cleared: tables,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Momentum research analysis — compact enough for phone
  app.get('/thesis', (_req, res) => {
    try {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_graduations,
          COUNT(new_pool_address) as with_pool,
          SUM(observation_complete) as observations_done
        FROM graduations
      `).get() as any;

      // Label distribution
      const labels = db.prepare(`
        SELECT
          label,
          COUNT(*) as count,
          ROUND(AVG(pct_t30), 1) as avg_pct_t30,
          ROUND(AVG(pct_t60), 1) as avg_pct_t60,
          ROUND(AVG(pct_t120), 1) as avg_pct_t120,
          ROUND(AVG(pct_t300), 1) as avg_pct_t300,
          ROUND(AVG(pct_t600), 1) as avg_pct_t600
        FROM graduation_momentum
        WHERE label IS NOT NULL
        GROUP BY label
      `).all() as any[];

      const totalLabeled = labels.reduce((s: number, l: any) => s + l.count, 0);
      const pumpCount = labels.find((l: any) => l.label === 'PUMP')?.count || 0;
      const dumpCount = labels.find((l: any) => l.label === 'DUMP')?.count || 0;
      const stableCount = labels.find((l: any) => l.label === 'STABLE')?.count || 0;
      const unlabeled = db.prepare(
        'SELECT COUNT(*) as count FROM graduation_momentum WHERE label IS NULL'
      ).get() as any;

      // Average price change by checkpoint (all graduations)
      const avgByCheckpoint = db.prepare(`
        SELECT
          ROUND(AVG(pct_t30), 2) as avg_t30,
          ROUND(AVG(pct_t60), 2) as avg_t60,
          ROUND(AVG(pct_t120), 2) as avg_t120,
          ROUND(AVG(pct_t300), 2) as avg_t300,
          ROUND(AVG(pct_t600), 2) as avg_t600,
          COUNT(pct_t30) as n_t30,
          COUNT(pct_t60) as n_t60,
          COUNT(pct_t120) as n_t120,
          COUNT(pct_t300) as n_t300,
          COUNT(pct_t600) as n_t600
        FROM graduation_momentum
      `).get() as any;

      // Filter signal: do holder/dev metrics predict outcome?
      const filterSignals = db.prepare(`
        SELECT
          label,
          ROUND(AVG(holder_count), 0) as avg_holders,
          ROUND(AVG(top5_wallet_pct), 1) as avg_top5_pct,
          ROUND(AVG(dev_wallet_pct), 1) as avg_dev_pct,
          ROUND(AVG(total_sol_raised), 2) as avg_sol_raised
        FROM graduation_momentum
        WHERE label IS NOT NULL
        GROUP BY label
      `).all();

      // Per-graduation detail (most recent, compact)
      const perGrad = db.prepare(`
        SELECT
          m.graduation_id as id,
          SUBSTR(g.mint, 1, 8) || '...' as mint,
          ROUND(m.open_price_sol, 10) as open_price,
          ROUND(m.pct_t30, 1) as t30,
          ROUND(m.pct_t60, 1) as t60,
          ROUND(m.pct_t120, 1) as t120,
          ROUND(m.pct_t300, 1) as t300,
          ROUND(m.pct_t600, 1) as t600,
          m.holder_count as holders,
          ROUND(m.top5_wallet_pct, 1) as top5,
          ROUND(m.dev_wallet_pct, 1) as dev,
          m.label
        FROM graduation_momentum m
        JOIN graduations g ON g.id = m.graduation_id
        ORDER BY m.graduation_id DESC
        LIMIT 30
      `).all();

      const verdict = totalLabeled < 10 ? 'INSUFFICIENT DATA — need 30+ labeled events' :
        pumpCount / totalLabeled > 0.51 ? `PROMISING — ${(pumpCount / totalLabeled * 100).toFixed(0)}% pump rate (${pumpCount}/${totalLabeled})` :
        pumpCount / totalLabeled > 0.4 ? `MARGINAL — ${(pumpCount / totalLabeled * 100).toFixed(0)}% pump rate, filters may help` :
        `WEAK — only ${(pumpCount / totalLabeled * 100).toFixed(0)}% pump rate`;

      res.json({
        thesis_verdict: verdict,
        pipeline: stats,
        label_distribution: {
          total_labeled: totalLabeled,
          unlabeled: unlabeled.count,
          PUMP: pumpCount,
          DUMP: dumpCount,
          STABLE: stableCount,
          pump_rate_pct: totalLabeled > 0 ? +(pumpCount / totalLabeled * 100).toFixed(1) : null,
        },
        avg_pct_by_checkpoint: avgByCheckpoint,
        labels_detail: labels,
        filter_signals: filterSignals,
        recent_graduations: perGrad,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Research data export — dump all collected spread/opportunity data
  app.get('/data', (_req, res) => {
    try {
      const graduations = db.prepare(`
        SELECT id, mint, final_price_sol, virtual_sol_reserves, virtual_token_reserves,
               final_sol_reserves, final_token_reserves,
               new_pool_address, new_pool_dex,
               datetime(timestamp, 'unixepoch') as grad_time,
               datetime(migration_timestamp, 'unixepoch') as migration_time,
               observation_complete
        FROM graduations ORDER BY timestamp DESC
      `).all();

      const priceComparisons = db.prepare(`
        SELECT pc.graduation_id, pc.seconds_since_graduation,
               pc.bonding_curve_price, pc.dex_pool_price,
               pc.bc_to_dex_spread_pct,
               g.mint
        FROM price_comparisons pc
        JOIN graduations g ON g.id = pc.graduation_id
        ORDER BY pc.graduation_id, pc.seconds_since_graduation
      `).all();

      const poolObservations = db.prepare(`
        SELECT graduation_id, seconds_since_graduation,
               pool_price_sol, pool_sol_reserves, pool_token_reserves
        FROM pool_observations
        ORDER BY graduation_id, seconds_since_graduation
      `).all();

      const opportunities = db.prepare(`
        SELECT o.graduation_id, o.max_spread_pct,
               o.duration_above_05_pct,
               o.duration_above_1_pct,
               o.duration_above_2_pct,
               o.estimated_profit_sol, o.net_profit_sol,
               o.viability_score, o.classification,
               g.mint, g.final_price_sol
        FROM opportunities o
        JOIN graduations g ON g.id = o.graduation_id
        ORDER BY o.viability_score DESC
      `).all();

      const competitionSignals = db.prepare(`
        SELECT graduation_id, seconds_since_graduation, action, is_likely_bot
        FROM competition_signals
        ORDER BY graduation_id, seconds_since_graduation
        LIMIT 200
      `).all();

      res.json({
        summary: {
          total_graduations: graduations.length,
          with_pool: graduations.filter((g: any) => g.new_pool_address).length,
          observations_complete: graduations.filter((g: any) => g.observation_complete).length,
          total_price_comparisons: priceComparisons.length,
          total_opportunities: opportunities.length,
        },
        graduations,
        priceComparisons,
        poolObservations,
        opportunities,
        competitionSignals,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const graduationCount = getGraduationCount(db);
    const listenerStats = listener ? listener.getStats() : null;

    res.json({
      status: listenerStatus === 'running' ? 'ok' : 'degraded',
      listener_status: listenerStatus,
      listener_error: listenerError,
      uptime_seconds: uptimeSeconds,
      graduation_count: graduationCount,
      listener_stats: listenerStats,
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(healthPort, () => {
    logger.info({ port: healthPort }, 'Health server listening');
  });

  // Start graduation listener (after Express so health endpoint is available)
  let listener: GraduationListener | null = null;
  try {
    listener = new GraduationListener(db);
    await listener.start();
    listenerStatus = 'running';
    logger.info('Graduation listener started successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    listenerStatus = 'error';
    listenerError = message;
    logger.error('Graduation listener failed to start: %s', message);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (listener) await listener.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Fatal error: %s', message);
  console.error('FATAL:', message);
  process.exit(1);
});
