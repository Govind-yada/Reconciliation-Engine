'use strict';

const config = require('../config');
const logger = require('../config/logger');
const { Transaction } = require('../db/models');

// ── Helpers ───────────────────────────────────────────────────────────────────

function typesMatch(userType, exchType, tolerances) {
  if (userType === exchType) return true;
  // Opposite-perspective transfer
  const equiv = config.typeEquivalences[userType];
  return equiv === exchType;
}

function timestampDeltaSeconds(a, b) {
  return Math.abs((a.getTime() - b.getTime()) / 1000);
}

function quantityDeltaPct(a, b) {
  if (a === 0 && b === 0) return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / base;
}

// ── Build conflict detail list ────────────────────────────────────────────────
function buildConflicts(user, exch, tolerances) {
  const conflicts = [];

  // Timestamp
  if (user.timestamp && exch.timestamp) {
    const delta = timestampDeltaSeconds(user.timestamp, exch.timestamp);
    if (delta > tolerances.timestampToleranceSeconds) {
      conflicts.push({
        field: 'timestamp',
        userValue: user.timestamp,
        exchangeValue: exch.timestamp,
        delta: `${delta.toFixed(1)}s (tolerance: ${tolerances.timestampToleranceSeconds}s)`,
      });
    }
  }

  // Quantity
  if (user.quantity !== null && exch.quantity !== null) {
    const pct = quantityDeltaPct(user.quantity, exch.quantity);
    if (pct > tolerances.quantityTolerancePct / 100) {
      conflicts.push({
        field: 'quantity',
        userValue: user.quantity,
        exchangeValue: exch.quantity,
        delta: `${(pct * 100).toFixed(4)}% (tolerance: ${tolerances.quantityTolerancePct}%)`,
      });
    }
  }

  return conflicts;
}

async function runMatching(runId, tolerances) {
  const tsSec = tolerances.timestampToleranceSeconds;
  const qtyPct = tolerances.quantityTolerancePct / 100; // convert % → fraction

  // Load only valid transactions for matching
  const [userTxns, exchTxns] = await Promise.all([
    Transaction.find({ runId, source: 'user', isValid: true }).lean(),
    Transaction.find({ runId, source: 'exchange', isValid: true }).lean(),
  ]);

  logger.info(`Matching ${userTxns.length} user txns vs ${exchTxns.length} exchange txns`);

  const entries = [];
  const matchedExchIds = new Set();

  // ── Pass 1: exact rawId match ────────────────────────────────────────────────
  const exchById = new Map(exchTxns.map((e) => [e.rawId, e]));
  const remainingUser = [];

  for (const user of userTxns) {
    const exch = exchById.get(user.rawId);
    if (exch && !matchedExchIds.has(exch._id.toString())) {
      matchedExchIds.add(exch._id.toString());
      const conflicts = buildConflicts(user, exch, tolerances);
      entries.push({
        runId,
        category: conflicts.length ? 'conflicting' : 'matched',
        reason: conflicts.length
          ? `Exact ID match but field(s) differ: ${conflicts.map((c) => c.field).join(', ')}`
          : 'Exact transaction_id match across both sources',
        userTransaction: flatten(user),
        exchangeTransaction: flatten(exch),
        conflicts,
      });
    } else {
      remainingUser.push(user);
    }
  }

  const remainingExch = exchTxns.filter((e) => !matchedExchIds.has(e._id.toString()));

  // ── Pass 2: proximity match ───────────────────────────────────────────────────
  const unmatchedExch = new Set(remainingExch.map((e) => e._id.toString()));

  for (const user of remainingUser) {
    if (!user.timestamp || !user.asset || !user.type) continue;

    const candidates = remainingExch.filter((exch) => {
      if (!unmatchedExch.has(exch._id.toString())) return false;
      if (!exch.timestamp || !exch.asset || !exch.type) return false;
      if (exch.asset !== user.asset) return false;
      if (!typesMatch(user.type, exch.type, tolerances)) return false;

      const deltaTs = timestampDeltaSeconds(user.timestamp, exch.timestamp);
      if (deltaTs > tsSec) return false;

      if (user.quantity !== null && exch.quantity !== null) {
        const deltaQty = quantityDeltaPct(user.quantity, exch.quantity);
        if (deltaQty > qtyPct * 5) return false; // wider net; conflicts detected later
      }

      return true;
    });

    if (candidates.length === 0) continue;

    // Pick best candidate = smallest timestamp delta
    candidates.sort(
      (a, b) =>
        timestampDeltaSeconds(user.timestamp, a.timestamp) -
        timestampDeltaSeconds(user.timestamp, b.timestamp)
    );
    const best = candidates[0];
    unmatchedExch.delete(best._id.toString());

    const conflicts = buildConflicts(user, best, tolerances);
    entries.push({
      runId,
      category: conflicts.length ? 'conflicting' : 'matched',
      reason: conflicts.length
        ? `Proximity match (asset+type+time window) but field(s) differ: ${conflicts.map((c) => c.field).join(', ')}`
        : 'Proximity match on asset, type, timestamp, and quantity within tolerance',
      userTransaction: flatten(user),
      exchangeTransaction: flatten(best),
      conflicts,
    });
  }

  // ── Pass 3: collect unmatched ────────────────────────────────────────────────
  // Determine which user txns were matched
  const matchedUserRawIds = new Set(entries.map((e) => e.userTransaction?.transaction_id));

  for (const user of userTxns) {
    if (matchedUserRawIds.has(user.rawId)) continue;
    entries.push({
      runId,
      category: 'unmatched_user',
      reason: buildUnmatchedUserReason(user),
      userTransaction: flatten(user),
      exchangeTransaction: null,
      conflicts: [],
    });
  }

  for (const exch of exchTxns) {
    if (!unmatchedExch.has(exch._id.toString())) continue;
    entries.push({
      runId,
      category: 'unmatched_exchange',
      reason: 'No matching transaction found in user file within configured tolerances',
      userTransaction: null,
      exchangeTransaction: flatten(exch),
      conflicts: [],
    });
  }

  // Also flag invalid rows as unmatched with quality reason
  const invalidUsers = await Transaction.find({ runId, source: 'user', isValid: false }).lean();
  const invalidExch = await Transaction.find({ runId, source: 'exchange', isValid: false }).lean();

  for (const u of invalidUsers) {
    entries.push({
      runId,
      category: 'unmatched_user',
      reason: `Invalid row – quality issues: ${u.qualityIssues.join('; ')}`,
      userTransaction: flatten(u),
      exchangeTransaction: null,
      conflicts: [],
    });
  }

  for (const e of invalidExch) {
    entries.push({
      runId,
      category: 'unmatched_exchange',
      reason: `Invalid row – quality issues: ${e.qualityIssues.join('; ')}`,
      userTransaction: null,
      exchangeTransaction: flatten(e),
      conflicts: [],
    });
  }

  logger.info(
    `Matching complete – matched: ${entries.filter((e) => e.category === 'matched').length}, ` +
    `conflicting: ${entries.filter((e) => e.category === 'conflicting').length}, ` +
    `unmatched_user: ${entries.filter((e) => e.category === 'unmatched_user').length}, ` +
    `unmatched_exchange: ${entries.filter((e) => e.category === 'unmatched_exchange').length}`
  );

  return entries;
}

// ── Flatten a MongoDB Transaction doc into a plain report object ───────────────
function flatten(doc) {
  if (!doc) return null;
  return {
    transaction_id: doc.rawId,
    timestamp: doc.timestamp ? doc.timestamp.toISOString() : null,
    type: doc.type,
    asset: doc.asset,
    quantity: doc.quantity,
    price_usd: doc.priceUsd,
    fee: doc.fee,
    note: doc.note,
    quality_issues: doc.qualityIssues?.length ? doc.qualityIssues.join('; ') : null,
  };
}

function buildUnmatchedUserReason(user) {
  const reasons = [];
  if (!user.timestamp) reasons.push('missing/malformed timestamp prevents time-window matching');
  if (!user.type) reasons.push('missing type');
  if (!user.asset) reasons.push('missing asset');
  if (reasons.length) return `Cannot match: ${reasons.join(', ')}`;
  return 'No matching transaction found in exchange file within configured tolerances';
}

module.exports = { runMatching };
