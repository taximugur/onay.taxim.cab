const logger = require('./logger');

async function humanDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(r => setTimeout(r, ms));
}

async function retry(fn, maxRetries = 3, backoffMs = 2000) {
  let lastErr;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn(`Retry ${i}/${maxRetries} — ${err.message}`);
      await humanDelay(backoffMs * i, backoffMs * i + 1000);
    }
  }
  throw lastErr;
}

module.exports = { humanDelay, retry };
