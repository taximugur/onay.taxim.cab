require('dotenv').config();

module.exports = {
  LOGIN_URL: process.env.LOGIN_URL || 'https://extracard.turkiyeshell.com',
  USERNAME: process.env.USERNAME,
  PASSWORD: process.env.PASSWORD,
  HEADLESS: process.env.HEADLESS !== 'false',
  ROWS_PER_PAGE: parseInt(process.env.ROWS_PER_PAGE) || 100,
  DELAY_MIN_MS: parseInt(process.env.DELAY_MIN_MS) || 500,
  DELAY_MAX_MS: parseInt(process.env.DELAY_MAX_MS) || 1500,
  DELAY_BETWEEN_PAGES_MS: parseInt(process.env.DELAY_BETWEEN_PAGES_MS) || 1000,
  MAX_RETRY: parseInt(process.env.MAX_RETRY) || 3,
  SESSION_CHECK_EVERY: parseInt(process.env.SESSION_CHECK_EVERY) || 50,
  SAVE_EVERY: parseInt(process.env.SAVE_EVERY) || 10,
  START_PAGE: parseInt(process.env.START_PAGE) || 1,
  REVERSE: process.env.REVERSE,
};
