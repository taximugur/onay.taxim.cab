require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const { login } = require('./src/auth');
const config = require('./src/config');
const logger = require('./src/logger');
const eventBus = require('./src/events');
const JobManager = require('./src/job-manager');
const { startDashboard } = require('./src/dashboard/server');
const { getState, setState } = require('./src/db');

async function main() {
  logger.info('=== Shell ExtraCard Bot başlatılıyor ===');

  // Stale "running" state temizle (önceki oturum crash/restart'tan kalmış olabilir)
  const dbState = getState();
  if (dbState.status === 'running') {
    setState({ status: 'idle' });
    logger.info('DB stale status temizlendi (running → idle)');
  }

  // Browser başlat
  const browser = await chromium.launch({ headless: config.HEADLESS !== false });
  const context = await browser.newContext({
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await context.newPage();

  // Login
  await login(page);

  // Job manager
  const jobManager = new JobManager(eventBus);
  jobManager.setPage(page);

  // Dashboard başlat
  const port = parseInt(process.env.DASHBOARD_PORT) || 3333;
  startDashboard(jobManager, eventBus, port);
  logger.info('Dashboard hazır → http://localhost:' + port);

  // Kapanış
  process.on('SIGTERM', async () => {
    logger.info('Bot kapatılıyor (SIGTERM)...');
    jobManager.stop();
    await browser.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Bot kapatılıyor (SIGINT)...');
    jobManager.stop();
    await browser.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
