const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../config/logger');

let isConnected = false;

async function connect() {
  if (isConnected) return;
  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    logger.info(`MongoDB connected: ${config.mongoUri}`);
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    throw err;
  }
}

async function disconnect() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB disconnected');
}

module.exports = { connect, disconnect };
