import express from 'express';
import pino from 'pino';
import { initDatabase } from './db/schema';
import { getGraduationCount } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'main' });

const startTime = Date.now();

async function main() {
  logger.info('Starting solana-graduation-arb-research');

  // Initialize database
  const dataDir = process.env.DATA_DIR || './data';
  const db = initDatabase(dataDir);

  // Start graduation listener
  const listener = new GraduationListener(db);
  await listener.start();

  // Start health/API server
  const healthPort = parseInt(process.env.HEALTH_PORT || '8080', 10);
  const app = express();

  app.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const graduationCount = getGraduationCount(db);

    res.json({
      status: 'ok',
      uptime_seconds: uptimeSeconds,
      graduation_count: graduationCount,
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(healthPort, () => {
    logger.info({ port: healthPort }, 'Health server listening');
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await listener.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
