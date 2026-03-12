const { humanDelay, retry } = require('./utils');
const { checkSession, refreshSession, navigateToApprovalPage } = require('./auth');
const { bulkInsert, getState, setState } = require('./db');
const logger = require('./logger');

async function waitForTable(page) {
  for (let i = 1; i <= 3; i++) {
    // Session kontrolü: login sayfasına düştüysek önce refresh yap
    const url = page.url();
    if (url.includes('login') || url.includes('giris') || !url.includes('validation')) {
      logger.warn('waitForTable: login sayfasına düşüldü, session yenileniyor...');
      await refreshSession(page);
    }
    try {
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 40000 });
      await humanDelay(400, 700);
      return;
    } catch(e) {
      logger.warn('Tablo gelmedi (deneme ' + i + '/3), yenileniyor...');
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
      await humanDelay(2000, 3000);
    }
  }
  throw new Error('Tablo 3 denemede yuklenemedi');
}

async function setRowsPerPage(page) {
  try {
    const options = await page.$$eval(
      '.rdt_Pagination select option, select option',
      opts => opts.filter(o => !isNaN(parseInt(o.value))).map(o => ({ value: o.value, text: o.textContent.trim() }))
    );
    let maxVal = 0, maxValue = null;
    for (const opt of options) {
      const n = parseInt(opt.value);
      if (n > maxVal) { maxVal = n; maxValue = opt.value; }
    }
    if (maxValue) {
      const sel = await page.$('.rdt_Pagination select') ? '.rdt_Pagination select' : 'select';
      await page.selectOption(sel, maxValue);
      logger.info('Rows per page: ' + maxVal);
      await waitForTable(page);
      return maxVal;
    }
  } catch(e) { logger.warn('Rows per page: ' + e.message); }
  return 10;
}

async function getTotalRecords(page) {
  try {
    const text = await page.evaluate(() => {
      const el = document.querySelector('[class*="rdt_Pagination"]');
      return el ? el.innerText : '';
    });
    const m = text.match(/\d+-\d+\s+of\s+([\d,]+)/i);
    if (m) return parseInt(m[1].replace(/,/g,''));
  } catch(e) { logger.warn('Toplam alinamadi: ' + e.message); }
  return null;
}

async function scrapeCurrentPage(page) {
  const rows = await page.$$('[class*="rdt_TableRow"]');
  if (rows.length === 0) throw new Error('rdt_TableRow bulunamadi!');
  const records = [];
  for (const row of rows) {
    const cells = await row.$$('[class*="rdt_TableCell"]');
    if (cells.length < 6) continue;
    const t = [];
    for (const c of cells) t.push(((await c.textContent())||'').trim());
    if (t[0]) records.push({
      referansNo: t[0], isim: t[1]||'', soyisim: t[2]||'',
      kartNo: t[3]||'', gsm: t[4]||'', plaka: t[5]||'',
      gonderilenSms: t[6]||'', manuelSmsLimiti: t[7]||'',
      kayitTarihi: t[8]||'', sonKullanimTarihi: t[9]||'',
    });
  }
  return records;
}

async function clickNextPage(page) {
  try {
    const btns = await page.$$('[class*="rdt_Pagination"] button');
    const active = [];
    for (const b of btns) if (!(await b.isDisabled())) active.push(b);
    if (active.length >= 2) { await active[active.length-2].click(); return true; }
    if (active.length === 1) { await active[0].click(); return true; }
  } catch(e) { logger.warn('Next page: ' + e.message); }
  return false;
}

// Session refresh sonrası hedef sayfaya git (page 1'den ileri tıklayarak)
async function navigateToPage(page, targetPage) {
  if (targetPage <= 1) return;
  logger.info('Session sonrasi sayfa ' + targetPage + "'e gidiliyor...");
  for (let p = 1; p < targetPage; p++) {
    const clicked = await clickNextPage(page);
    if (!clicked) break;
    try {
      await page.waitForFunction(() => {
        const r = document.querySelector('[class*="rdt_TableRow"]');
        return r && r.textContent.trim().length > 0;
      }, { timeout: 8000 });
    } catch(e) { await humanDelay(300, 500); }
    if (p % 50 === 0) logger.info('Konum: ' + p + '/' + (targetPage-1));
  }
  await waitForTable(page);
  logger.info('Hedef sayfaya ulasildi: ' + targetPage);
}

async function scrapeAllRecords(page, onProgress) {
  const state = getState();
  const startPage = (state.lastPage || 0) + 1;

  await navigateToApprovalPage(page);
  await waitForTable(page);

  let rowsPerPage = state.rowsPerPage || 30;
  rowsPerPage = await setRowsPerPage(page);
  await waitForTable(page);

  // Devam modunda hedef sayfaya git
  if (startPage > 1) {
    logger.info('Devam modu: sayfa ' + startPage + "'e gidiliyor...");
    await navigateToPage(page, startPage);
  }

  const total = await getTotalRecords(page);
  const totalPages = total ? Math.ceil(total / rowsPerPage) : 9999;
  setState({ totalPages, rowsPerPage, totalRecords: total || 0, lastRun: new Date().toISOString(), status: 'running' });
  logger.info('PLAN: ' + total + ' kayit / ' + rowsPerPage + ' = ' + totalPages + ' sayfa | Baslangic: ' + startPage);

  let prevFirstRef = null;
  const config = require('./config');

  for (let page_n = startPage; page_n <= totalPages; page_n++) {
    const pageRecords = await retry(async () => {
      const rowCheck = await page.$('[class*="rdt_TableRow"]');
      if (!rowCheck) {
        const alive = await checkSession(page);
        if (!alive) {
          // Session bitti: yeniden login + approval sayfası + doğru sayfaya git
          await refreshSession(page);
          await setRowsPerPage(page);
          await navigateToPage(page, page_n);
        } else {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        }
        await waitForTable(page);
      }
      const recs = await scrapeCurrentPage(page);
      if (recs.length === 0) throw new Error('Sayfa bos!');
      return recs;
    }, config.MAX_RETRY);

    const inserted = bulkInsert(pageRecords);
    setState({ lastPage: page_n });

    if (onProgress) onProgress({ page: page_n, totalPages, inserted, pageSize: pageRecords.length });

    if (page_n % config.SESSION_CHECK_EVERY === 0) {
      const alive = await checkSession(page);
      if (!alive) {
        await refreshSession(page);
        await setRowsPerPage(page);
        await navigateToPage(page, page_n + 1);
        await waitForTable(page);
      }
    }

    if (page_n >= totalPages) break;

    prevFirstRef = pageRecords[0] ? pageRecords[0].referansNo : null;
    const clicked = await clickNextPage(page);
    if (!clicked) { logger.warn('Son sayfa'); break; }

    try {
      await page.waitForFunction(
        (prev) => { const r = document.querySelector('[class*="rdt_TableRow"]'); if (!r) return false; const c = r.querySelector('[class*="rdt_TableCell"]'); return c && c.textContent.trim() !== prev; },
        prevFirstRef, { timeout: 15000 }
      );
    } catch(e) { await page.waitForLoadState('networkidle', { timeout: 10000 }); }

    await humanDelay(config.DELAY_BETWEEN_PAGES_MS, config.DELAY_BETWEEN_PAGES_MS + 200);
  }

  setState({ status: 'done', lastRun: new Date().toISOString() });
}

module.exports = { scrapeAllRecords };
