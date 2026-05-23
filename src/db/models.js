const mongoose = require('mongoose');

// ── Raw transaction (one collection per source) ──────────────────────────────
const transactionSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    source: { type: String, enum: ['user', 'exchange'], required: true },
    rawId: { type: String, required: true },           // original transaction_id
    timestamp: { type: Date, default: null },           // null if unparseable
    type: { type: String, default: null },
    asset: { type: String, default: null },            // normalised (uppercase)
    quantity: { type: Number, default: null },
    priceUsd: { type: Number, default: null },
    fee: { type: Number, default: null },
    note: { type: String, default: '' },
    // Data quality
    isValid: { type: Boolean, default: true },
    qualityIssues: [{ type: String }],
    rawRow: { type: mongoose.Schema.Types.Mixed },      // original CSV row preserved
  },
  { timestamps: true }
);

transactionSchema.index({ runId: 1, source: 1 });
transactionSchema.index({ runId: 1, asset: 1, timestamp: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

// ── Reconciliation run ────────────────────────────────────────────────────────
const reconciliationRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'ingesting', 'matching', 'completed', 'failed'],
      default: 'pending',
    },
    config: {
      timestampToleranceSeconds: Number,
      quantityTolerancePct: Number,
    },
    summary: {
      totalUser: { type: Number, default: 0 },
      totalExchange: { type: Number, default: 0 },
      invalidUser: { type: Number, default: 0 },
      invalidExchange: { type: Number, default: 0 },
      matched: { type: Number, default: 0 },
      conflicting: { type: Number, default: 0 },
      unmatchedUser: { type: Number, default: 0 },
      unmatchedExchange: { type: Number, default: 0 },
    },
    error: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const ReconciliationRun = mongoose.model('ReconciliationRun', reconciliationRunSchema);

// ── Report entry ─────────────────────────────────────────────────────────────
const reportEntrySchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    category: {
      type: String,
      enum: ['matched', 'conflicting', 'unmatched_user', 'unmatched_exchange'],
      required: true,
      index: true,
    },
    reason: { type: String, required: true },
    userTransaction: { type: mongoose.Schema.Types.Mixed, default: null },
    exchangeTransaction: { type: mongoose.Schema.Types.Mixed, default: null },
    conflicts: [
      {
        field: String,
        userValue: mongoose.Schema.Types.Mixed,
        exchangeValue: mongoose.Schema.Types.Mixed,
        delta: mongoose.Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true }
);

reportEntrySchema.index({ runId: 1, category: 1 });

const ReportEntry = mongoose.model('ReportEntry', reportEntrySchema);

module.exports = { Transaction, ReconciliationRun, ReportEntry };
