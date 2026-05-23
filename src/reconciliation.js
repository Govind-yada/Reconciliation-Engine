'use strict';

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const logger = require('./config/logger');
const { ingestCSV } = require('./ingestion');
const { runMatching } = require('./matching');
const { ReconciliationRun, ReportEntry } = require('./db/models');

const DATA_DIR = path.join(__dirname, '../../data');

async function reconcile(userFilePath, exchangeFilePath, overrides = {}) {
  const runId = uuidv4();

  const tolerances = {
    timestampToleranceSeconds:
      overrides.timestampToleranceSeconds ?? config.matching.timestampToleranceSeconds,
    quantityTolerancePct:
      overrides.quantityTolerancePct ?? config.matching.quantityTolerancePct,
  };

  // Create run record
  await ReconciliationRun.create({
    runId,
    status: 'pending',
    config: tolerances,
  });

  // Run async (don't await – caller gets runId immediately)
  setImmediate(() => _executeRun(runId, userFilePath, exchangeFilePath, tolerances));

  return runId;
}

async function _executeRun(runId, userFilePath, exchangeFilePath, tolerances) {
  try {
    await ReconciliationRun.findOneAndUpdate({ runId }, { status: 'ingesting' });

    // ── Ingestion ──────────────────────────────────────────────────────────────
    const [userStats, exchStats] = await Promise.all([
      ingestCSV(userFilePath, 'user', runId),
      ingestCSV(exchangeFilePath, 'exchange', runId),
    ]);

    await ReconciliationRun.findOneAndUpdate(
      { runId },
      {
        status: 'matching',
        'summary.totalUser': userStats.total,
        'summary.totalExchange': exchStats.total,
        'summary.invalidUser': userStats.invalid,
        'summary.invalidExchange': exchStats.invalid,
      }
    );

    // ── Matching ───────────────────────────────────────────────────────────────
    const entries = await runMatching(runId, tolerances);

    // ── Persist report entries ────────────────────────────────────────────────
    if (entries.length > 0) {
      await ReportEntry.insertMany(entries, { ordered: false });
    }

    const summary = {
      matched: entries.filter((e) => e.category === 'matched').length,
      conflicting: entries.filter((e) => e.category === 'conflicting').length,
      unmatchedUser: entries.filter((e) => e.category === 'unmatched_user').length,
      unmatchedExchange: entries.filter((e) => e.category === 'unmatched_exchange').length,
    };

    await ReconciliationRun.findOneAndUpdate(
      { runId },
      {
        status: 'completed',
        completedAt: new Date(),
        'summary.matched': summary.matched,
        'summary.conflicting': summary.conflicting,
        'summary.unmatchedUser': summary.unmatchedUser,
        'summary.unmatchedExchange': summary.unmatchedExchange,
      }
    );

    logger.info(`Run ${runId} completed`, summary);
  } catch (err) {
    logger.error(`Run ${runId} failed`, { error: err.message, stack: err.stack });
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      { status: 'failed', error: err.message }
    );
  }
}

module.exports = { reconcile };
