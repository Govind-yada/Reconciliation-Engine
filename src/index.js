'use strict';

const config = require('./config');
const logger = require('./config/logger');
const { connect } = require('./db/connection');
const { createApp } = require('./api/app');

async function bootstrap() {
  await connect();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`KoinX Reconciliation Engine running on port ${config.port}`);
    logger.info(`  POST /reconcile         – trigger a reconciliation run`);
    logger.info(`  GET  /report/:runId     – full report (add ?format=csv for CSV download)`);
    logger.info(`  GET  /report/:runId/summary   – counts only`);
    logger.info(`  GET  /report/:runId/unmatched – unmatched rows only`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received – shutting down`);
    server.close(async () => {
      const { disconnect } = require('./db/connection');
      await disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
