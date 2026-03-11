require('dotenv').config({ override: true });
const fs = require('fs');
['data','logs','screenshots'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

const { launchBrowser, closeBrowser, getPage } = require('./src/browser');
const { login } = require('./src/auth');
const { scrapeAllRecords } = require('./src/scraper');
const { setState, getCount } = require('./src/db');
const logger = require('./src/logger');

process.on('SIGTERM', async () => {
  logger.warn('SIGTERM alindi, durduruluyor...');
  setState({ status: 'stopped' });
  await closeBrowser().catch(() => {});
  process.exit(0);
});

async function main() {
  const t0 = Date.now();
  logger.info('=== Shell ExtraCard Scraper baslatiliyor ===');

  const config = require('./src/config');
  if (!config.USERNAME || !config.PASSWORD) {
    logger.error('USERNAME / PASSWORD eksik'); process.exit(1);
  }

  try {
    await launchBrowser();
    const page = await getPage();
    await login(page);

    await scrapeAllRecords(page, ({ page: p, totalPages, inserted, pageSize }) => {
      logger.info('Sayfa ' + p + '/' + totalPages + ' -- +' + inserted + ' yeni -- DB toplam: ' + getCount());
    });

    const dur = ((Date.now()-t0)/1000/60).toFixed(1);
    logger.info('=== TAMAMLANDI: DB kayit: ' + getCount() + ' (' + dur + ' dk) ===');
  } catch(e) {
    logger.error('Fatal: ' + e.message);
    setState({ status: 'error' });
  } finally {
    await closeBrowser().catch(() => {});
  }
}
main();
