require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/koinx_reconciliation',
  logLevel: process.env.LOG_LEVEL || 'info',

  matching: {
    timestampToleranceSeconds: parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS, 10) || 300,
    quantityTolerancePct: parseFloat(process.env.QUANTITY_TOLERANCE_PCT) || 0.01,
  },

  // Canonical asset aliases: all keys normalize to the value
  assetAliases: {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    polygon: 'MATIC',
    tether: 'USDT',
    chainlink: 'LINK',
  },

  // Type equivalences for opposite-perspective transfers
  typeEquivalences: {
    TRANSFER_IN: 'TRANSFER_OUT',
    TRANSFER_OUT: 'TRANSFER_IN',
  },
};

module.exports = config;
