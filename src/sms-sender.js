const { humanDelay } = require('./utils');
const { navigateToApprovalPage } = require('./auth');
const { checkSession, refreshSession } = require('./auth');
const logger = require('./logger');

/**
 * Portal üzerinde Playwright ile toplu SMS gönder.
 *
 * @param {Page}     page         - Playwright sayfası
 * @param {Set}      targetRefs   - Gönderilecek referansNo'lar (Set)
 * @param {Function} onProgress   - (sent, skipped, failed, total) callback
 * @param {Function} checkStop    - () => bool, durdurmak için
 * @returns {{ sent, skipped, failed }}
 */
async function sendBulkSMS(page, targetRefs, onProgress, checkStop) {
  let sent = 0, skipped = 0, failed = 0;
  const total = targetRefs.size;
  const remaining = new Set(targetRefs);

  // Onay sayfasına git
  await navigateToApprovalPage(page);
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 });

  // Rows per page max yap
  await setMaxRowsPerPage(page);
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });

  const totalPages = await getTotalPages(page);
  logger.info('SMS tarama başladı: ' + total + ' hedef, ' + totalPages + ' sayfa');

  let prevFirstRef = null;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (checkStop && checkStop()) break;
    if (remaining.size === 0) {
      logger.info('Tüm hedefler tamamlandı, tarama sonlandırılıyor.');
      break;
    }

    // Session kontrol
    if (pageNum % 50 === 0) {
      const alive = await checkSession(page);
      if (!alive) {
        await refreshSession(page);
        await setMaxRowsPerPage(page);
        await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
      }
    }

    // Sayfadaki satırları işle
    const rows = await page.$$('[class*="rdt_TableRow"]');

    for (const row of rows) {
      if (checkStop && checkStop()) break;

      const cells = await row.$$('[class*="rdt_TableCell"]');
      if (cells.length < 8) continue;

      const ref = ((await cells[0].textContent()) || '').trim();
      if (!ref || !remaining.has(ref)) continue;

      const gonderilenSms = parseInt(((await cells[6].textContent()) || '0').trim()) || 0;
      const manuelLimit   = parseInt(((await cells[7].textContent()) || '0').trim()) || 0;

      if (gonderilenSms >= manuelLimit && manuelLimit > 0) {
        logger.warn('SMS limiti dolu: ' + ref + ' (' + gonderilenSms + '/' + manuelLimit + ')');
        skipped++;
        remaining.delete(ref);
        if (onProgress) onProgress({ ref, status: 'limit', sent, skipped, failed, total });
        continue;
      }

      // SMS butonunu tıkla
      const smsBtn = await row.$('.btn-primary, button:has-text("SMS Gönder")');
      if (!smsBtn) {
        logger.warn('SMS butonu yok: ' + ref);
        skipped++;
        remaining.delete(ref);
        continue;
      }

      try {
        // Response'u yakala
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
            if (!success) logger.warn('SMS API yanıtı: ' + JSON.stringify(json));
          } catch { success = response.status() === 200; }
        } else {
          // Response yakalanamadıysa butona tıklandı sayılır
          success = true;
        }

        if (success) {
          sent++;
          logger.info('SMS gönderildi: ' + ref);
          if (onProgress) onProgress({ ref, status: 'ok', sent, skipped, failed, total });
        } else {
          failed++;
          if (onProgress) onProgress({ ref, status: 'error', sent, skipped, failed, total });
        }
        remaining.delete(ref);

        // Kısa bekleme — portal rate limit önlemi
        await humanDelay(400, 700);

      } catch (e) {
        logger.warn('SMS tıklama hatası ' + ref + ': ' + e.message);
        failed++;
        remaining.delete(ref);
        if (onProgress) onProgress({ ref, status: 'error', error: e.message, sent, skipped, failed, total });
      }
    }

    if (pageNum >= totalPages) break;

    // Sonraki sayfaya geç
    prevFirstRef = rows[0] ? ((await rows[0].$eval('[class*="rdt_TableCell"]', el => el.textContent.trim()).catch(() => ''))) : null;
    const clicked = await clickNext(page);
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
  return { sent, skipped, failed };
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

async function getTotalPages(page) {
  try {
    const text = await page.evaluate(() => {
      const el = document.querySelector('[class*="rdt_Pagination"]');
      return el ? el.innerText : '';
    });
    const rowsPerPage = await page.evaluate(() => {
      const sel = document.querySelector('.rdt_Pagination select, select');
      return sel ? parseInt(sel.value) : 30;
    });
    const m = text.match(/\d+-\d+\s+of\s+([\d,]+)/i);
    if (m) {
      const total = parseInt(m[1].replace(/,/g,''));
      return Math.ceil(total / rowsPerPage);
    }
  } catch(e) {}
  return 9999;
}

async function clickNext(page) {
  try {
    const btns = await page.$$('[class*="rdt_Pagination"] button');
    const active = [];
    for (const b of btns) if (!(await b.isDisabled())) active.push(b);
    if (active.length >= 2) { await active[active.length-2].click(); return true; }
    if (active.length === 1) { await active[0].click(); return true; }
  } catch(e) {}
  return false;
}

module.exports = { sendBulkSMS };
