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
