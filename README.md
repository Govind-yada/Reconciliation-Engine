# KoinX Transaction Reconciliation Engine

A production-grade Node.js service that ingests two sources of crypto transaction data (user-exported and exchange-exported), matches them using a configurable tolerance algorithm, and produces a structured reconciliation report.

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Setup & Installation](#setup--installation)
3. [Running the Service](#running-the-service)
4. [API Reference](#api-reference)
5. [Configuration](#configuration)
6. [Matching Algorithm](#matching-algorithm)
7. [Data Quality Handling](#data-quality-handling)
8. [Key Design Decisions](#key-design-decisions)
9. [Running Tests](#running-tests)

---

## Architecture Overview

```
src/
├── config/         # App config + Winston logger
├── db/
│   ├── connection.js  # Mongoose connect/disconnect
│   └── models.js      # Transaction, ReconciliationRun, ReportEntry schemas
├── ingestion/      # CSV parsing, validation, deduplication
├── matching/       # Matching engine (exact ID + proximity)
├── report/         # CSV report generator
├── api/
│   ├── app.js         # Express factory
│   ├── middleware/    # Error handler, 404
│   └── routes/        # /reconcile, /report
├── reconciliation.js  # Orchestrator (async run lifecycle)
└── index.js           # Bootstrap / graceful shutdown
test/
└── integration.js  # Standalone integration test (no DB required)
data/
├── user_transactions.csv
├── exchange_transactions.csv
└── reconciliation_report.csv   # generated after test run
```

---

## Setup & Installation

### Prerequisites
- Node.js ≥ 18
- MongoDB ≥ 6 (local or Atlas)

```bash
git clone <repo-url>
cd koinx-reconciliation
npm install
```

Copy `.env` and update if needed:
```bash
cp .env .env.local
# Edit MONGODB_URI, PORT, tolerances as required
```

Place your CSV files in the `data/` directory:
```
data/user_transactions.csv
data/exchange_transactions.csv
```

---

## Running the Service

```bash
# Production
npm start

# Development (auto-restart)
npm run dev
```

The server starts on port `3000` (configurable).

---

## API Reference

### `POST /reconcile`
Triggers a reconciliation run. Returns a `runId` immediately; processing is async.

**Request body** (all optional):
```json
{
  "timestampToleranceSeconds": 300,
  "quantityTolerancePct": 0.01,
  "userFile": "/absolute/path/to/user.csv",
  "exchangeFile": "/absolute/path/to/exchange.csv"
}
```

**Response `202 Accepted`:**
```json
{
  "success": true,
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Reconciliation run started. Use GET /report/:runId to poll for results.",
  "effectiveConfig": {
    "timestampToleranceSeconds": 300,
    "quantityTolerancePct": 0.01
  }
}
```

---

### `GET /report/:runId`
Full reconciliation report as JSON. Add `?format=csv` for a downloadable CSV.

**Response:**
```json
{
  "success": true,
  "runId": "...",
  "status": "completed",
  "config": { "timestampToleranceSeconds": 300, "quantityTolerancePct": 0.01 },
  "summary": {
    "totalUser": 25, "totalExchange": 25,
    "invalidUser": 4, "invalidExchange": 0,
    "matched": 20, "conflicting": 1,
    "unmatchedUser": 4, "unmatchedExchange": 4
  },
  "entries": [ ... ]
}
```

---

### `GET /report/:runId/summary`
Counts only — lightweight polling endpoint.

---

### `GET /report/:runId/unmatched`
Only `unmatched_user` and `unmatched_exchange` entries with reasons.

---

### `GET /health`
Service health check.

---

## Configuration

All tolerances can be set via environment variables **or** overridden per-request via the `POST /reconcile` body.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MONGODB_URI` | `mongodb://localhost:27017/koinx_reconciliation` | MongoDB connection string |
| `TIMESTAMP_TOLERANCE_SECONDS` | `300` | Max seconds between timestamps to consider a match |
| `QUANTITY_TOLERANCE_PCT` | `0.01` | Max quantity delta (%) to consider a match |
| `LOG_LEVEL` | `info` | Winston log level |

---

## Matching Algorithm

Matching runs in two passes:

### Pass 1 — Exact `transaction_id` Match
If the same `transaction_id` appears on both sides, it is paired immediately. Fields are still compared for conflicts.

### Pass 2 — Proximity Match
For unmatched rows, candidates are shortlisted where:
1. **Asset** matches (case-insensitive; aliases resolved, e.g. `bitcoin → BTC`)
2. **Type** matches exactly **or** is a known opposite-perspective pair:
   - `TRANSFER_OUT` (user) ↔ `TRANSFER_IN` (exchange)
3. **Timestamp delta** ≤ `TIMESTAMP_TOLERANCE_SECONDS`
4. **Quantity delta** ≤ `5 × QUANTITY_TOLERANCE_PCT` (wider net; exact threshold applied in conflict classification)

Among shortlisted candidates, the one with the smallest timestamp delta wins.

### Classification
After pairing, each pair is classified:
- **`matched`** — all fields within tolerance
- **`conflicting`** — paired, but quantity or timestamp exceeds tolerance

Unpaired rows become:
- **`unmatched_user`** — present only in user file
- **`unmatched_exchange`** — present only in exchange file

Invalid rows (bad data) are never matched and are reported as unmatched with their quality issue reason.

---

## Data Quality Handling

The ingestion layer checks every row and **flags — never silently drops** bad rows:

| Issue | Flag |
|---|---|
| Missing `transaction_id` | `MISSING_TRANSACTION_ID` |
| Missing timestamp | `MISSING_TIMESTAMP` |
| Unparseable timestamp | `MALFORMED_TIMESTAMP: "<value>"` |
| Missing type | `MISSING_TYPE` |
| Missing asset | `MISSING_ASSET` |
| Missing/non-numeric quantity | `MISSING_OR_INVALID_QUANTITY` |
| Negative quantity | `NEGATIVE_QUANTITY: <value>` |
| Duplicate `transaction_id` in same file | `DUPLICATE_ID` |

All quality issues are logged via Winston and stored in the `qualityIssues` array on the `Transaction` document. Invalid rows appear in the report as `unmatched_*` with the quality issue as the reason.

---

## Key Design Decisions

### Why async reconciliation runs?
Large datasets (millions of rows) cannot be processed within a single HTTP request timeout. The `/reconcile` endpoint returns a `runId` immediately and processing happens in the background. Clients poll `/report/:runId/summary` to check status.

### Why MongoDB?
Flexible schema suits messy CSV data (unknown columns, nulls). Index on `(runId, source, asset, timestamp)` makes proximity queries fast. Transactions, runs, and report entries are in separate collections to allow independent querying.

### Why two-pass matching (ID first, then proximity)?
ID-based matching is O(1) and unambiguous. Proximity matching handles the common real-world case where the same transaction has different IDs across systems. Separating passes prevents a proximity match from "stealing" a row that has a valid ID match.

### Fee differences are not match-breaking
The assignment specifies `quantity` and `timestamp` as the tolerance fields. Fee discrepancies are captured in the raw row data but do not affect categorisation — they may differ due to exchange rebates or rounding and are not a reliable signal for mismatch.

### Transfer direction equivalences
`TRANSFER_OUT` on the user side and `TRANSFER_IN` on the exchange side represent the same physical movement of funds from different perspectives. The engine maps these as equivalent during matching.

### Asset aliases
A configurable alias map (`config.assetAliases`) normalises common name variants (`bitcoin → BTC`, `ethereum → ETH`, etc.) before comparison. New aliases can be added without code changes.

### Duplicate handling
Duplicate `transaction_id` values within the **same** file are flagged on the second occurrence (the first is kept). Both the flag and the reason are stored; no row is silently dropped.

### CSV format for reports
JSON works for API consumers; CSV is requested explicitly for the report output. The service supports both: JSON by default, CSV via `?format=csv` on `GET /report/:runId`.

---

## Running Tests

A standalone integration test exercises the full ingestion + matching + reporting pipeline **without** a live MongoDB connection:

```bash
node test/integration.js
```

Expected output: **10/10 assertions pass**, covering:
- Asset alias resolution (`bitcoin → BTC`)
- Opposite-perspective transfer matching (`TRANSFER_OUT ↔ TRANSFER_IN`)
- Quantity conflict detection
- Duplicate ID flagging
- Malformed timestamp flagging
- Negative quantity flagging
- Exchange-only unmatched detection
- Fee-difference tolerance
#   R e c o n c i l i a t i o n - E n g i n e  
 