const { chromium } = require('playwright');
const config = require('./config');

let browser = null;
let context = null;
let page = null;

async function launchBrowser() {
  browser = await chromium.launch({
    headless: config.HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  context = await browser.newContext({
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  page = await context.newPage();
  return page;
}

async function getPage() {
  return page;
}

async function closeBrowser() {
  if (browser) await browser.close();
}

module.exports = { launchBrowser, getPage, closeBrowser };
