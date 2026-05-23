'use strict';

const express = require('express');
const { ReconciliationRun, ReportEntry } = require('../../db/models');
const { generateCSVReport } = require('../../report');

const router = express.Router({ mergeParams: true });

// ── Helper: fetch run or 404 ──────────────────────────────────────────────────
async function getRun(runId, res) {
  const run = await ReconciliationRun.findOne({ runId }).lean();
  if (!run) {
    res.status(404).json({ success: false, error: `Run "${runId}" not found` });
    return null;
  }
  return run;
}


router.get('/:runId', async (req, res, next) => {
  try {
    const { runId } = req.params;
    const run = await getRun(runId, res);
    if (!run) return;

    if (run.status !== 'completed' && run.status !== 'failed') {
      return res.status(202).json({
        success: true,
        runId,
        status: run.status,
        message: 'Run is still in progress. Poll again shortly.',
      });
    }

    if (req.query.format === 'csv') {
      const csv = await generateCSVReport(runId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="reconciliation_${runId}.csv"`);
      return res.send(csv);
    }

    const entries = await ReportEntry.find({ runId }).lean();
    return res.json({
      success: true,
      runId,
      status: run.status,
      config: run.config,
      completedAt: run.completedAt,
      summary: run.summary,
      entries,
    });
  } catch (err) {
    next(err);
  }
});


router.get('/:runId/summary', async (req, res, next) => {
  try {
    const { runId } = req.params;
    const run = await getRun(runId, res);
    if (!run) return;

    return res.json({
      success: true,
      runId,
      status: run.status,
      config: run.config,
      completedAt: run.completedAt,
      summary: run.summary,
    });
  } catch (err) {
    next(err);
  }
});


router.get('/:runId/unmatched', async (req, res, next) => {
  try {
    const { runId } = req.params;
    const run = await getRun(runId, res);
    if (!run) return;

    const entries = await ReportEntry.find({
      runId,
      category: { $in: ['unmatched_user', 'unmatched_exchange'] },
    }).lean();

    return res.json({
      success: true,
      runId,
      status: run.status,
      total: entries.length,
      entries,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
