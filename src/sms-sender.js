const { humanDelay } = require('./utils');
const { navigateToApprovalPage, checkSession, refreshSession } = require('./auth');
const logger = require('./logger');

/**
 * Portaldaki filtre alanlarını doldurur, "Ara" basar ve toplam kayıt sayısını döner.
 * filters: { kayitStart, kayitEnd, search }  (tarihler YYYY-MM-DD formatında)
 */
async function applyPortalFilters(page, filters = {}) {
  await navigateToApprovalPage(page);
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 });

  const hasDate   = !!(filters.kayitStart || filters.kayitEnd);
  const hasSearch = !!(filters.search && filters.search.trim());

  if (hasDate || hasSearch) {
    if (hasDate) {
      // YYYY-MM-DD → DD-MM-YYYY
      const toPortal = d => d.split('-').reverse().join('-');
      const start = filters.kayitStart || filters.kayitEnd;
      const end   = filters.kayitEnd   || filters.kayitStart;
      const dateRange = toPortal(start) + ' - ' + toPortal(end);

      try {
        const inp = page.locator('input[placeholder*="Kayıt Tarihi"], input[placeholder*="kayit"], input[placeholder*="tarih"]').first();
        await inp.click({ timeout: 5000 });
        await inp.fill('');
        await inp.fill(dateRange);
        logger.info('Tarih filtresi: ' + dateRange);
      } catch(e) {
        logger.warn('Tarih filtresi uygulanamadı: ' + e.message);
      }
    }

    if (hasSearch) {
      try {
        const inp = page.locator('input[placeholder*="içinde ara"], input[placeholder*="Kayıtlar içinde"]').first();
        await inp.fill(filters.search.trim());
        logger.info('Arama filtresi: ' + filters.search);
      } catch(e) {
        logger.warn('Arama filtresi uygulanamadı: ' + e.message);
      }
    }

    // "Ara" butonuna tıkla
    try {
      await page.locator('button:has-text("Ara")').first().click({ timeout: 5000 });
      await humanDelay(1800, 2500);
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
    } catch(e) {
      logger.warn('"Ara" butonu tıklanamadı: ' + e.message);
      await humanDelay(2000, 3000);
    }
  }

  const total = await _getTotalCount(page);
  logger.info('Portal filtre sonucu: ' + total + ' kayıt');
  return total;
}

async function _getTotalCount(page) {
  try {
    const text = await page.evaluate(() => {
      const el = document.querySelector('[class*="rdt_Pagination"]');
      return el ? el.innerText : '';
    });
    const m = text.match(/\d+\s*-\s*\d+\s+of\s+([\d,]+)/i);
    if (m) return parseInt(m[1].replace(/,/g, ''));
  } catch(e) {}
  return 0;
}

/**
 * Portal üzerinde toplu SMS gönder.
 * Filtreler bu fonksiyon içinde uygulanır.
 *
 * @param {Page}     page
 * @param {Object}   filters       - { kayitStart, kayitEnd, search }
 * @param {Function} onProgress    - ({ ref, status, sent, skipped, failed, total })
 * @param {Function} checkPauseStop - async, pause bekler / stop atar
 */
async function sendBulkSMS(page, filters, onProgress, checkPauseStop) {
  let sent = 0, skipped = 0, failed = 0;

  // Filtrele, konumlan, toplam al
  const total = await applyPortalFilters(page, filters || {});

  await setMaxRowsPerPage(page);
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });

  const totalPages = await _getTotalPages(page);
  logger.info('SMS tarama başladı: ' + total + ' kayıt, ' + totalPages + ' sayfa');

  let prevFirstRef = null;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (checkPauseStop) await checkPauseStop();

    // Session kontrol
    if (pageNum % 50 === 0) {
      const alive = await checkSession(page);
      if (!alive) {
        await refreshSession(page);
        await applyPortalFilters(page, filters || {});
        await setMaxRowsPerPage(page);
        await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
      }
    }

    const rows = await page.$$('[class*="rdt_TableRow"]');

    for (const row of rows) {
      if (checkPauseStop) await checkPauseStop();

      const cells = await row.$$('[class*="rdt_TableCell"]');
      if (cells.length < 8) continue;

      const ref = ((await cells[0].textContent()) || '').trim();
      if (!ref) continue;

      const gonderilenSms = parseInt(((await cells[6].textContent()) || '0').trim()) || 0;
      const manuelLimit   = parseInt(((await cells[7].textContent()) || '0').trim()) || 0;

      if (manuelLimit > 0 && gonderilenSms >= manuelLimit) {
        logger.warn('SMS limiti dolu: ' + ref + ' (' + gonderilenSms + '/' + manuelLimit + ')');
        skipped++;
        if (onProgress) onProgress({ ref, status: 'limit', sent, skipped, failed, total });
        continue;
      }

      const smsBtn = await row.$('.btn-primary, button:has-text("SMS Gönder")');
      if (!smsBtn) {
        logger.warn('SMS butonu yok: ' + ref);
        skipped++;
        continue;
      }

      try {
        const [response] = await Promise.all([
          page.waitForResponse(
            r => r.url().includes('reSendSms') || r.url().includes('sendSms'),
            { timeout: 10000 }
          ).catch(() => null),
          smsBtn.click(),
        ]);

        let success = false;
        if (response) {
          try {
            const json = await response.json();
            success = json.Success === true || json.success === true;
            if (!success) logger.warn('SMS API: ' + JSON.stringify(json));
          } catch { success = response.status() === 200; }
        } else {
          success = true; // Response yakalanamadı ama tıklandı
        }

        if (success) {
          sent++;
          logger.info('SMS gönderildi: ' + ref);
          if (onProgress) onProgress({ ref, status: 'ok', sent, skipped, failed, total });
        } else {
          failed++;
          if (onProgress) onProgress({ ref, status: 'error', sent, skipped, failed, total });
        }

        await humanDelay(400, 700);

      } catch(e) {
        logger.warn('SMS tıklama hatası ' + ref + ': ' + e.message);
        failed++;
        if (onProgress) onProgress({ ref, status: 'error', error: e.message, sent, skipped, failed, total });
      }
    }

    if (pageNum >= totalPages) break;

    prevFirstRef = rows[0]
      ? await rows[0].$eval('[class*="rdt_TableCell"]', el => el.textContent.trim()).catch(() => '')
      : null;

    const clicked = await _clickNext(page);
    if (!clicked) break;

    try {
      await page.waitForFunction(
        (prev) => {
          const r = document.querySelector('[class*="rdt_TableRow"]');
          if (!r) return false;
          const c = r.querySelector('[class*="rdt_TableCell"]');
          return c && c.textContent.trim() !== prev;
        },
        prevFirstRef, { timeout: 12000 }
      );
    } catch { await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); }

    await humanDelay(200, 400);
  }

  logger.info('SMS tamamlandı — gönderildi: ' + sent + ', atlandı: ' + skipped + ', hata: ' + failed);
  return { sent, skipped, failed, total };
}

async function setMaxRowsPerPage(page) {
  try {
    const options = await page.$$eval(
      '.rdt_Pagination select option, select option',
      opts => opts.filter(o => !isNaN(parseInt(o.value))).map(o => ({ value: o.value }))
    );
    let maxVal = 0, maxValue = null;
    for (const opt of options) {
      const n = parseInt(opt.value);
      if (n > maxVal) { maxVal = n; maxValue = opt.value; }
    }
    if (maxValue) {
      const sel = await page.$('.rdt_Pagination select') ? '.rdt_Pagination select' : 'select';
      await page.selectOption(sel, maxValue);
      await page.waitForTimeout(1500);
    }
  } catch(e) { logger.warn('setMaxRowsPerPage: ' + e.message); }
}

async function _getTotalPages(page) {
  try {
    const rowsPerPage = await page.evaluate(() => {
      const sel = document.querySelector('.rdt_Pagination select, select');
      return sel ? parseInt(sel.value) : 30;
    });
    const total = await _getTotalCount(page);
    if (total && rowsPerPage) return Math.ceil(total / rowsPerPage);
  } catch(e) {}
  return 9999;
}

async function _clickNext(page) {
  try {
    const btns = await page.$$('[class*="rdt_Pagination"] button');
    const active = [];
    for (const b of btns) if (!(await b.isDisabled())) active.push(b);
    if (active.length >= 2) { await active[active.length - 2].click(); return true; }
    if (active.length === 1) { await active[0].click(); return true; }
  } catch(e) {}
  return false;
}

module.exports = { sendBulkSMS, applyPortalFilters };
