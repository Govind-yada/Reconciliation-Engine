'use strict';

const { stringify } = require('csv-stringify/sync');
const { ReportEntry } = require('../db/models');
const logger = require('../config/logger');

const REPORT_COLUMNS = [
  'category',
  'reason',
  // user side
  'user_transaction_id',
  'user_timestamp',
  'user_type',
  'user_asset',
  'user_quantity',
  'user_price_usd',
  'user_fee',
  'user_note',
  'user_quality_issues',
  // exchange side
  'exchange_transaction_id',
  'exchange_timestamp',
  'exchange_type',
  'exchange_asset',
  'exchange_quantity',
  'exchange_price_usd',
  'exchange_fee',
  'exchange_note',
  'exchange_quality_issues',
  // conflict details
  'conflict_fields',
  'conflict_details',
];

function entryToRow(entry) {
  const u = entry.userTransaction || {};
  const e = entry.exchangeTransaction || {};
  const conflictFields = (entry.conflicts || []).map((c) => c.field).join(', ');
  const conflictDetails = (entry.conflicts || [])
    .map((c) => `${c.field}: user=${c.userValue} exchange=${c.exchangeValue} (Δ ${c.delta})`)
    .join(' | ');

  return {
    category: entry.category,
    reason: entry.reason,
    user_transaction_id: u.transaction_id ?? '',
    user_timestamp: u.timestamp ?? '',
    user_type: u.type ?? '',
    user_asset: u.asset ?? '',
    user_quantity: u.quantity ?? '',
    user_price_usd: u.price_usd ?? '',
    user_fee: u.fee ?? '',
    user_note: u.note ?? '',
    user_quality_issues: u.quality_issues ?? '',
    exchange_transaction_id: e.transaction_id ?? '',
    exchange_timestamp: e.timestamp ?? '',
    exchange_type: e.type ?? '',
    exchange_asset: e.asset ?? '',
    exchange_quantity: e.quantity ?? '',
    exchange_price_usd: e.price_usd ?? '',
    exchange_fee: e.fee ?? '',
    exchange_note: e.note ?? '',
    exchange_quality_issues: e.quality_issues ?? '',
    conflict_fields: conflictFields,
    conflict_details: conflictDetails,
  };
}

async function generateCSVReport(runId) {
  const entries = await ReportEntry.find({ runId }).lean();
  logger.info(`Generating CSV report for run ${runId} with ${entries.length} entries`);

  const rows = entries.map(entryToRow);
  return stringify(rows, { header: true, columns: REPORT_COLUMNS });
}

module.exports = { generateCSVReport };
