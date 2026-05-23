'use strict';

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const config = require('../config');
const logger = require('../config/logger');
const { Transaction } = require('../db/models');

// ── Asset normalisation ───────────────────────────────────────────────────────
function normaliseAsset(raw) {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return (config.assetAliases[lower] || raw.trim().toUpperCase());
}

// ── Timestamp parsing ─────────────────────────────────────────────────────────
function parseTimestamp(raw) {
  if (!raw || !raw.trim()) return null;
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) return null;
  return d;
}

// ── Number parsing ────────────────────────────────────────────────────────────
function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

// ── Type normalisation ────────────────────────────────────────────────────────
function normaliseType(raw) {
  if (!raw) return null;
  return raw.trim().toUpperCase();
}

// ── Row → domain object with quality flags ────────────────────────────────────
function parseRow(row, source) {
  const issues = [];

  const rawId = (row.transaction_id || '').trim();
  const timestamp = parseTimestamp(row.timestamp);
  const type = normaliseType(row.type);
  const asset = normaliseAsset(row.asset);
  const quantity = parseNumber(row.quantity);
  const priceUsd = parseNumber(row.price_usd);
  const fee = parseNumber(row.fee);
  const note = (row.note || '').trim();

  // ── Quality checks ──────────────────────────────────────────────────────────
  if (!rawId) issues.push('MISSING_TRANSACTION_ID');

  if (!row.timestamp || !row.timestamp.trim()) {
    issues.push('MISSING_TIMESTAMP');
  } else if (timestamp === null) {
    issues.push(`MALFORMED_TIMESTAMP: "${row.timestamp.trim()}"`);
  }

  if (!type) issues.push('MISSING_TYPE');

  if (!asset) issues.push('MISSING_ASSET');

  if (quantity === null) {
    issues.push('MISSING_OR_INVALID_QUANTITY');
  } else if (quantity < 0) {
    issues.push(`NEGATIVE_QUANTITY: ${quantity}`);
  }

  if (priceUsd !== null && priceUsd < 0) issues.push(`NEGATIVE_PRICE: ${priceUsd}`);
  if (fee !== null && fee < 0) issues.push(`NEGATIVE_FEE: ${fee}`);

  const isValid = issues.length === 0;

  if (!isValid) {
    logger.warn(`[${source.toUpperCase()}] Data quality issue on row "${rawId || 'UNKNOWN'}"`, {
      issues,
      row,
    });
  }

  return {
    rawId,
    timestamp,
    type,
    asset,
    quantity,
    priceUsd,
    fee,
    note,
    isValid,
    qualityIssues: issues,
    rawRow: row,
  };
}

// ── Deduplication within a single file ───────────────────────────────────────
function deduplicateRows(rows, source) {
  const seen = new Map();
  const result = [];

  for (const row of rows) {
    const id = row.rawId;
    if (!id) {
      result.push(row);
      continue;
    }
    if (seen.has(id)) {
      logger.warn(`[${source.toUpperCase()}] Duplicate transaction_id "${id}" – skipping duplicate`);
      // Mark the already-stored entry with a quality issue instead of silently dropping
      const existing = seen.get(id);
      existing.qualityIssues.push(`DUPLICATE_ID: appeared ${seen.get(id)._count + 1} times`);
      existing.isValid = false;
      existing._count = (existing._count || 1) + 1;
    } else {
      row._count = 1;
      seen.set(id, row);
      result.push(row);
    }
  }

  return result;
}

// ── Main ingestion function ───────────────────────────────────────────────────
async function ingestCSV(filePath, source, runId) {
  logger.info(`Ingesting ${source} file: ${filePath}`);

  const fileContent = fs.readFileSync(filePath, 'utf8');
  const rawRows = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true, // don't crash on extra commas
  });

  logger.info(`[${source.toUpperCase()}] Parsed ${rawRows.length} raw rows`);

  const parsedRows = rawRows.map((row) => parseRow(row, source));
  const deduplicatedRows = deduplicateRows(parsedRows, source);

  // Bulk-insert into MongoDB
  const docs = deduplicatedRows.map((r) => ({
    runId,
    source,
    rawId: r.rawId,
    timestamp: r.timestamp,
    type: r.type,
    asset: r.asset,
    quantity: r.quantity,
    priceUsd: r.priceUsd,
    fee: r.fee,
    note: r.note,
    isValid: r.isValid,
    qualityIssues: r.qualityIssues,
    rawRow: r.rawRow,
  }));

  await Transaction.insertMany(docs, { ordered: false });

  const invalidCount = deduplicatedRows.filter((r) => !r.isValid).length;
  logger.info(
    `[${source.toUpperCase()}] Stored ${docs.length} rows (${invalidCount} flagged with quality issues)`
  );

  return { total: docs.length, invalid: invalidCount };
}

module.exports = { ingestCSV };
