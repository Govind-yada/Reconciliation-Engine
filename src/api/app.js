'use strict';

const express = require('express');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const reconcileRouter = require('./routes/reconcile');
const reportRouter = require('./routes/report');

function createApp() {
  const app = express();

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // Routes
  app.use('/reconcile', reconcileRouter);
  app.use('/report', reportRouter);

  // 404 + error handlers (must be last)
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
