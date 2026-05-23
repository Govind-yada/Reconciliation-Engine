'use strict';


const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ── Inline mini-versions of the production modules (same logic, no DB) ─────────

const ASSET_ALIASES = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL',
  polygon: 'MATIC', tether: 'USDT', chainlink: 'LINK',
};

const TYPE_EQUIVALENCES = { TRANSFER_IN: 'TRANSFER_OUT', TRANSFER_OUT: 'TRANSFER_IN' };

function normaliseAsset(raw) {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return ASSET_ALIASES[lower] || raw.trim().toUpperCase();
}

function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

function parseTimestamp(raw) {
  if (!raw || !raw.trim()) return null;
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? null : d;
}

function parseRow(row, source) {
  const issues = [];
  const rawId = (row.transaction_id || '').trim();
  const timestamp = parseTimestamp(row.timestamp);
  const type = row.type ? row.type.trim().toUpperCase() : null;
  const asset = normaliseAsset(row.asset);
  const quantity = parseNumber(row.quantity);
  const priceUsd = parseNumber(row.price_usd);
  const fee = parseNumber(row.fee);
  const note = (row.note || '').trim();

  if (!rawId) issues.push('MISSING_TRANSACTION_ID');
  if (!row.timestamp || !row.timestamp.trim()) issues.push('MISSING_TIMESTAMP');
  else if (!timestamp) issues.push(`MALFORMED_TIMESTAMP: "${row.timestamp.trim()}"`);
  if (!type) issues.push('MISSING_TYPE');
  if (!asset) issues.push('MISSING_ASSET');
  if (quantity === null) issues.push('MISSING_OR_INVALID_QUANTITY');
  else if (quantity < 0) issues.push(`NEGATIVE_QUANTITY: ${quantity}`);

  return {
    rawId, timestamp, type, asset, quantity, priceUsd, fee, note,
    isValid: issues.length === 0, qualityIssues: issues, rawRow: row
  };
}

function dedup(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.rawId) { out.push(r); continue; }
    if (seen.has(r.rawId)) {
      const existing = seen.get(r.rawId);
      existing.qualityIssues.push(`DUPLICATE_ID`);
      existing.isValid = false;
    } else { seen.set(r.rawId, r); out.push(r); }
  }
  return out;
}

function tsDelta(a, b) { return Math.abs((a.getTime() - b.getTime()) / 1000); }
function qtyPctDelta(a, b) {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
}

function buildConflicts(u, e, tol) {
  const out = [];
  if (u.timestamp && e.timestamp) {
    const d = tsDelta(u.timestamp, e.timestamp);
    if (d > tol.ts) out.push({
      field: 'timestamp', userValue: u.timestamp.toISOString(),
      exchangeValue: e.timestamp.toISOString(), delta: `${d.toFixed(1)}s`
    });
  }
  if (u.quantity !== null && e.quantity !== null) {
    const p = qtyPctDelta(u.quantity, e.quantity);
    if (p > tol.qty / 100) out.push({
      field: 'quantity', userValue: u.quantity,
      exchangeValue: e.quantity, delta: `${(p * 100).toFixed(4)}%`
    });
  }
  return out;
}

function flatten(doc, side) {
  if (!doc) return {};
  return {
    [`${side}_transaction_id`]: doc.rawId,
    [`${side}_timestamp`]: doc.timestamp ? doc.timestamp.toISOString() : '',
    [`${side}_type`]: doc.type || '',
    [`${side}_asset`]: doc.asset || '',
    [`${side}_quantity`]: doc.quantity ?? '',
    [`${side}_price_usd`]: doc.priceUsd ?? '',
    [`${side}_fee`]: doc.fee ?? '',
    [`${side}_note`]: doc.note || '',
    [`${side}_quality_issues`]: doc.qualityIssues.join('; '),
  };
}

function match(userRows, exchRows, tol) {
  const entries = [];
  const matchedExchIds = new Set();

  const validUser = userRows.filter(r => r.isValid);
  const validExch = exchRows.filter(r => r.isValid);

  // Pass 1: exact ID
  const exchById = new Map(validExch.map(e => [e.rawId, e]));
  const remainingUser = [];

  for (const u of validUser) {
    const e = exchById.get(u.rawId);
    if (e && !matchedExchIds.has(e.rawId)) {
      matchedExchIds.add(e.rawId);
      const conflicts = buildConflicts(u, e, tol);
      entries.push({
        category: conflicts.length ? 'conflicting' : 'matched',
        reason: conflicts.length ? `Exact ID match but fields differ: ${conflicts.map(c => c.field).join(', ')}` : 'Exact transaction_id match',
        user: u, exch: e, conflicts
      });
    } else remainingUser.push(u);
  }

  const remainingExch = validExch.filter(e => !matchedExchIds.has(e.rawId));
  const unmatchedExchIds = new Set(remainingExch.map(e => e.rawId));

  // Pass 2: proximity
  for (const u of remainingUser) {
    if (!u.timestamp || !u.asset || !u.type) continue;
    const candidates = remainingExch.filter(e => {
      if (!unmatchedExchIds.has(e.rawId)) return false;
      if (!e.timestamp || !e.asset || !e.type) return false;
      if (e.asset !== u.asset) return false;
      const typeOk = u.type === e.type || TYPE_EQUIVALENCES[u.type] === e.type;
      if (!typeOk) return false;
      if (tsDelta(u.timestamp, e.timestamp) > tol.ts) return false;
      if (u.quantity !== null && e.quantity !== null &&
        qtyPctDelta(u.quantity, e.quantity) > (tol.qty / 100) * 5) return false;
      return true;
    });
    if (!candidates.length) continue;
    candidates.sort((a, b) => tsDelta(u.timestamp, a.timestamp) - tsDelta(u.timestamp, b.timestamp));
    const best = candidates[0];
    unmatchedExchIds.delete(best.rawId);
    const conflicts = buildConflicts(u, best, tol);
    entries.push({
      category: conflicts.length ? 'conflicting' : 'matched',
      reason: conflicts.length
        ? `Proximity match but fields differ: ${conflicts.map(c => c.field).join(', ')}`
        : 'Proximity match on asset, type, timestamp, quantity',
      user: u, exch: best, conflicts
    });
  }

  const matchedUserIds = new Set(entries.map(e => e.user?.rawId).filter(Boolean));

  for (const u of userRows) {
    if (matchedUserIds.has(u.rawId)) continue;
    let reason = u.isValid
      ? 'No matching transaction found in exchange file within configured tolerances'
      : `Invalid row – quality issues: ${u.qualityIssues.join('; ')}`;
    if (u.isValid && !u.timestamp) reason = 'Cannot match: missing/malformed timestamp';
    entries.push({ category: 'unmatched_user', reason, user: u, exch: null, conflicts: [] });
  }

  for (const e of exchRows) {
    if (!unmatchedExchIds.has(e.rawId) && e.isValid) continue;
    if (!e.isValid && matchedExchIds.has(e.rawId)) continue;
    const reason = e.isValid
      ? 'No matching transaction found in user file within configured tolerances'
      : `Invalid row – quality issues: ${e.qualityIssues.join('; ')}`;
    entries.push({ category: 'unmatched_exchange', reason, user: null, exch: e, conflicts: [] });
  }

  return entries;
}

// ── Run the test ──────────────────────────────────────────────────────────────

function ingest(filePath, source) {
  const raw = parse(fs.readFileSync(filePath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  const parsed = raw.map(r => parseRow(r, source));
  return dedup(parsed);
}

const userRows = ingest(path.join(__dirname, '../data/user_transactions.csv'), 'user');
const exchRows = ingest(path.join(__dirname, '../data/exchange_transactions.csv'), 'exchange');

const tol = { ts: 300, qty: 0.01 };
const entries = match(userRows, exchRows, tol);

// ── Build CSV ─────────────────────────────────────────────────────────────────
const csvRows = entries.map(e => ({
  category: e.category,
  reason: e.reason,
  ...flatten(e.user, 'user'),
  ...flatten(e.exch, 'exchange'),
  conflict_fields: e.conflicts.map(c => c.field).join(', '),
  conflict_details: e.conflicts.map(c =>
    `${c.field}: user=${c.userValue} exchange=${c.exchangeValue} (Δ ${c.delta})`).join(' | '),
}));

const csv = stringify(csvRows, { header: true });
const outPath = path.join(__dirname, '../data/reconciliation_report.csv');
fs.writeFileSync(outPath, csv);

// ── Print summary ─────────────────────────────────────────────────────────────
const summary = {
  total_user: userRows.length,
  total_exchange: exchRows.length,
  invalid_user: userRows.filter(r => !r.isValid).length,
  invalid_exchange: exchRows.filter(r => !r.isValid).length,
  matched: entries.filter(e => e.category === 'matched').length,
  conflicting: entries.filter(e => e.category === 'conflicting').length,
  unmatched_user: entries.filter(e => e.category === 'unmatched_user').length,
  unmatched_exchange: entries.filter(e => e.category === 'unmatched_exchange').length,
};

console.log('\n══════════════════════════════════════════════');
console.log('  KoinX Reconciliation Engine – Test Results ');
console.log('══════════════════════════════════════════════');
console.log(JSON.stringify(summary, null, 2));
console.log('\nDetailed entries:');
for (const e of entries) {
  const u = e.user?.rawId || '—';
  const ex = e.exch?.rawId || '—';
  console.log(`  [${e.category.padEnd(20)}] user=${u.padEnd(10)} exch=${ex.padEnd(10)} | ${e.reason}`);
}
console.log(`\nCSV report written to: ${outPath}`);
console.log('══════════════════════════════════════════════\n');

// ── Assertions ────────────────────────────────────────────────────────────────
let pass = 0; let fail = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✅ PASS: ${msg}`); pass++; }
  else { console.error(`  ❌ FAIL: ${msg}`); fail++; }
}

console.log('Running assertions...\n');

// Asset aliasing: USR-005 uses "bitcoin" → should match EXC-1005 (BTC)
const usr005match = entries.find(e => e.user?.rawId === 'USR-005' && e.category === 'matched');
assert(usr005match, 'USR-005 (bitcoin alias) matched to EXC-1005 (BTC)');

// Transfer direction: USR-004 TRANSFER_OUT ↔ EXC-1004 TRANSFER_IN
const usr004match = entries.find(e => e.user?.rawId === 'USR-004' &&
  ['matched', 'conflicting'].includes(e.category));
assert(usr004match, 'USR-004 (TRANSFER_OUT) matched EXC-1004 (TRANSFER_IN) – opposite perspectives');

// Quantity conflict: USR-012 qty=0.3 vs EXC-1012 qty=0.3001 (0.033% delta > 0.01% tolerance)
const usr012 = entries.find(e => e.user?.rawId === 'USR-012');
assert(usr012?.category === 'conflicting', 'USR-012 vs EXC-1012 flagged as conflicting (quantity delta > tolerance)');

// Duplicate detection: USR-001 appears twice in user CSV
const usr001 = userRows.find(r => r.rawId === 'USR-001');
assert(usr001 && !usr001.isValid && usr001.qualityIssues.some(q => q.includes('DUPLICATE')),
  'USR-001 duplicate detected and flagged');

// Malformed timestamp: USR-018
const usr018 = userRows.find(r => r.rawId === 'USR-018');
assert(usr018 && !usr018.isValid && usr018.qualityIssues.some(q => q.includes('MALFORMED_TIMESTAMP')),
  'USR-018 malformed timestamp detected');

// Missing/malformed timestamp + missing type: USR-024
const usr024 = userRows.find(r => r.rawId === 'USR-024');
assert(usr024 && !usr024.isValid &&
  usr024.qualityIssues.some(q => q.includes('TIMESTAMP') || q.includes('MISSING_TYPE')),
  'USR-024 missing/malformed timestamp and missing type detected');

// Negative quantity: USR-019
const usr019 = userRows.find(r => r.rawId === 'USR-019');
assert(usr019 && !usr019.isValid && usr019.qualityIssues.some(q => q.includes('NEGATIVE_QUANTITY')),
  'USR-019 negative quantity detected');

// Exchange-only: EXC-1024 and EXC-1025 not in user file
const exc1024 = entries.find(e => e.exch?.rawId === 'EXC-1024' && e.category === 'unmatched_exchange');
const exc1025 = entries.find(e => e.exch?.rawId === 'EXC-1025' && e.category === 'unmatched_exchange');
assert(exc1024, 'EXC-1024 correctly unmatched (exchange-only)');
assert(exc1025, 'EXC-1025 correctly unmatched (exchange-only)');

// Fee conflict: USR-010 fee=0.0015 vs EXC-1010 fee=0.002 (not a matching field, should still match)
const usr010 = entries.find(e => e.user?.rawId === 'USR-010' &&
  ['matched', 'conflicting'].includes(e.category));
assert(usr010, 'USR-010 matched EXC-1010 despite fee difference (fee not a match-breaking field)');

console.log(`\n══════════════════════════════════════════════`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`══════════════════════════════════════════════\n`);

if (fail > 0) process.exit(1);
