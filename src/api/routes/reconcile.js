'use strict';

const express = require('express');
const path = require('path');
const { reconcile } = require('../../reconciliation');
const logger = require('../../config/logger');

const router = express.Router();

const DEFAULT_USER_FILE = path.join(__dirname, '../../../data/user_transactions.csv');
const DEFAULT_EXCHANGE_FILE = path.join(__dirname, '../../../data/exchange_transactions.csv');


router.post('/', async (req, res, next) => {
  try {
    const { timestampToleranceSeconds, quantityTolerancePct, userFile, exchangeFile } = req.body || {};

    const overrides = {};
    if (timestampToleranceSeconds !== undefined) {
      const v = Number(timestampToleranceSeconds);
      if (isNaN(v) || v < 0) {
        return res.status(400).json({ success: false, error: 'timestampToleranceSeconds must be a non-negative number' });
      }
      overrides.timestampToleranceSeconds = v;
    }
    if (quantityTolerancePct !== undefined) {
      const v = Number(quantityTolerancePct);
      if (isNaN(v) || v < 0) {
        return res.status(400).json({ success: false, error: 'quantityTolerancePct must be a non-negative number' });
      }
      overrides.quantityTolerancePct = v;
    }

    const uFile = userFile || DEFAULT_USER_FILE;
    const eFile = exchangeFile || DEFAULT_EXCHANGE_FILE;

    const runId = await reconcile(uFile, eFile, overrides);

    logger.info(`Reconciliation triggered`, { runId, overrides });

    return res.status(202).json({
      success: true,
      runId,
      message: 'Reconciliation run started. Use GET /report/:runId to poll for results.',
      effectiveConfig: {
        timestampToleranceSeconds: overrides.timestampToleranceSeconds ?? 'default',
        quantityTolerancePct: overrides.quantityTolerancePct ?? 'default',
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
