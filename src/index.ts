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

  // Condensed thesis verification — small enough to read on a phone
  app.get('/thesis', (_req, res) => {
    try {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_graduations,
          COUNT(new_pool_address) as with_pool,
          SUM(observation_complete) as observations_done
        FROM graduations
      `).get() as any;

      // Spread distribution across all snapshots
      const spreads = db.prepare(`
        SELECT
          COUNT(*) as total_snapshots,
          ROUND(AVG(bc_to_dex_spread_pct), 4) as avg_spread_pct,
          ROUND(MIN(bc_to_dex_spread_pct), 4) as min_spread_pct,
          ROUND(MAX(bc_to_dex_spread_pct), 4) as max_spread_pct,
          SUM(CASE WHEN ABS(bc_to_dex_spread_pct) > 0.5 THEN 1 ELSE 0 END) as above_05_pct,
          SUM(CASE WHEN ABS(bc_to_dex_spread_pct) > 1.0 THEN 1 ELSE 0 END) as above_1_pct,
          SUM(CASE WHEN ABS(bc_to_dex_spread_pct) > 2.0 THEN 1 ELSE 0 END) as above_2_pct,
          SUM(CASE WHEN ABS(bc_to_dex_spread_pct) > 5.0 THEN 1 ELSE 0 END) as above_5_pct
        FROM price_comparisons
        WHERE bc_to_dex_spread_pct IS NOT NULL
      `).get() as any;

      // Spread by time bucket
      const spreadByTime = db.prepare(`
        SELECT
          CASE
            WHEN seconds_since_graduation <= 5 THEN '0-5s'
            WHEN seconds_since_graduation <= 10 THEN '5-10s'
            WHEN seconds_since_graduation <= 30 THEN '10-30s'
            WHEN seconds_since_graduation <= 60 THEN '30-60s'
            WHEN seconds_since_graduation <= 120 THEN '60-120s'
            ELSE '120s+'
          END as time_bucket,
          COUNT(*) as n,
          ROUND(AVG(bc_to_dex_spread_pct), 4) as avg_spread,
          ROUND(MIN(bc_to_dex_spread_pct), 4) as min_spread,
          ROUND(MAX(bc_to_dex_spread_pct), 4) as max_spread
        FROM price_comparisons
        WHERE bc_to_dex_spread_pct IS NOT NULL
        GROUP BY time_bucket
        ORDER BY MIN(seconds_since_graduation)
      `).all();

      // Per-graduation summary
      const perGrad = db.prepare(`
        SELECT
          g.id,
          SUBSTR(g.mint, 1, 8) || '...' as mint_short,
          ROUND(g.final_price_sol, 10) as bc_price,
          COUNT(pc.id) as snapshots,
          ROUND(MIN(pc.bc_to_dex_spread_pct), 4) as min_spread,
          ROUND(MAX(pc.bc_to_dex_spread_pct), 4) as max_spread,
          ROUND(AVG(pc.bc_to_dex_spread_pct), 4) as avg_spread
        FROM graduations g
        JOIN price_comparisons pc ON pc.graduation_id = g.id
        WHERE pc.bc_to_dex_spread_pct IS NOT NULL
        GROUP BY g.id
        ORDER BY MAX(ABS(pc.bc_to_dex_spread_pct)) DESC
      `).all();

      // Opportunity scores
      const opps = db.prepare(`
        SELECT
          o.graduation_id as grad_id,
          SUBSTR(g.mint, 1, 8) || '...' as mint,
          ROUND(o.max_spread_pct, 4) as max_spread,
          o.duration_above_05_pct as dur_05,
          o.duration_above_1_pct as dur_1,
          o.duration_above_2_pct as dur_2,
          ROUND(o.estimated_profit_sol, 6) as est_profit,
          ROUND(o.net_profit_sol, 6) as net_profit,
          ROUND(o.viability_score, 1) as score,
          o.classification
        FROM opportunities o
        JOIN graduations g ON g.id = o.graduation_id
        ORDER BY o.viability_score DESC
      `).all();

      // Competition
      const competition = db.prepare(`
        SELECT
          graduation_id,
          COUNT(*) as total_signals,
          SUM(CASE WHEN is_likely_bot = 1 THEN 1 ELSE 0 END) as bot_signals,
          SUM(CASE WHEN seconds_since_graduation <= 10 THEN 1 ELSE 0 END) as within_10s
        FROM competition_signals
        GROUP BY graduation_id
      `).all();

      // Pool price snapshots (compact)
      const poolPrices = db.prepare(`
        SELECT
          graduation_id as grad_id,
          ROUND(seconds_since_graduation, 1) as t,
          ROUND(pool_price_sol, 10) as price,
          ROUND(pool_sol_reserves, 4) as sol,
          ROUND(pool_token_reserves, 0) as tokens
        FROM pool_observations
        WHERE pool_price_sol IS NOT NULL
        ORDER BY graduation_id, seconds_since_graduation
      `).all();

      const verdict = !spreads.total_snapshots ? 'INSUFFICIENT DATA' :
        spreads.above_1_pct > spreads.total_snapshots * 0.3 ? 'STRONG SIGNAL — frequent >1% spreads' :
        spreads.above_05_pct > spreads.total_snapshots * 0.3 ? 'MODERATE SIGNAL — frequent >0.5% spreads' :
        spreads.above_05_pct > 0 ? 'WEAK SIGNAL — occasional >0.5% spreads' :
        'NO SIGNAL — spreads too tight';

      res.json({
        thesis_verdict: verdict,
        pipeline: stats,
        spread_overview: spreads,
        spread_by_time_bucket: spreadByTime,
        per_graduation: perGrad,
        opportunities: opps,
        competition,
        pool_prices: poolPrices,
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
