const fs = require('fs');
const { humanDelay } = require('./utils');
const { navigateToApprovalPage, checkSession, refreshSession } = require('./auth');
const logger = require('./logger');

const AYLAR = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
               'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { day, month, year };
}

async function shot(page, name) {
  try {
    const p = 'screenshots/filter-' + name + '.png';
    await page.screenshot({ path: p });
    logger.info('Screenshot: ' + p);
  } catch(e) {}
}

/**
 * Portaldaki filtre alanlarını doldurur, "Ara" basar ve toplam kayıt sayısını döner.
 * filters: { kayitStart, kayitEnd, search }  (tarihler YYYY-MM-DD formatında)
 */
async function applyPortalFilters(page, filters = {}, _retry = 0) {
  await navigateToApprovalPage(page);

  // Session kontrol — login sayfasına redirect olduysa yeniden giriş yap
  const urlAfterNav = page.url();
  if (urlAfterNav.includes('login') || urlAfterNav.includes('giris') || !urlAfterNav.includes('validation')) {
    if (_retry < 2) {
      logger.warn('applyPortalFilters: session kopuk, yeniden login...');
      await refreshSession(page);
      return applyPortalFilters(page, filters, _retry + 1);
    }
    logger.warn('applyPortalFilters: session yenilenemedi');
    return 0;
  }

  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 });

  // DOM'u kaydet — selector'leri kesinleştirmek için
  try {
    const html = await page.content();
    fs.writeFileSync('data/page-dom.html', html);
    logger.info('DOM kaydedildi: data/page-dom.html');
  } catch(e) {}

  await shot(page, '1-before');

  const hasDate   = !!(filters.kayitStart && filters.kayitEnd);
  const hasSearch = !!(filters.search && filters.search.trim());

  if (hasDate) {
    const start = parseDate(filters.kayitStart);
    const end   = parseDate(filters.kayitEnd);

    try {
      // Tarih input'una tıkla — takvim açılır
      const dateInput = page.locator(
        'input[placeholder*="Kayıt Tarihi"], ' +
        'input[placeholder*="kayıt tarihi"], ' +
        'input[placeholder*="tarih"], ' +
        'label:has-text("Kayıt Tarihi") + input, ' +
        'label:has-text("Kayıt Tarihi") ~ input'
      ).first();

      await dateInput.click({ timeout: 8000 });
      await humanDelay(600, 900);
      await shot(page, '2-calendar-open');

      // Takvim popup'ını bekle
      const calSel = '.datepicker, .calendar, [class*="picker"], [class*="calendar"], ' +
                     '[class*="daterangepicker"], [class*="DatePicker"], [class*="date-picker"]';
      try {
        await page.waitForSelector(calSel, { timeout: 5000 });
      } catch(e) {
        logger.warn('Takvim popup bekleniyor timeout, devam ediliyor...');
      }

      // Başlangıç ayına git
      await navigateToMonth(page, start.month, start.year);
      await humanDelay(300, 500);

      // Başlangıç gününe tıkla
      await clickDay(page, start.day);
      await humanDelay(400, 600);
      await shot(page, '3-start-selected');

      // Bitiş ayına git (farklı aysa)
      if (end.month !== start.month || end.year !== start.year) {
        await navigateToMonth(page, end.month, end.year);
        await humanDelay(300, 500);
      }

      // Bitiş gününe tıkla
      await clickDay(page, end.day);
      await humanDelay(500, 800);
      await shot(page, '4-end-selected');

      // Takvim kapanmadıysa Escape ile kapat
      const calStillOpen = await page.$(calSel).catch(() => null);
      if (calStillOpen) {
        await page.keyboard.press('Escape');
        await humanDelay(300, 500);
      }

      logger.info('Tarih filtresi uygulandı: ' + filters.kayitStart + ' — ' + filters.kayitEnd);
    } catch(e) {
      logger.warn('Tarih filtresi hatası: ' + e.message);
      await shot(page, 'error-date');
    }
  }

  if (hasSearch) {
    try {
      const inp = page.locator(
        'input[placeholder*="içinde ara"], ' +
        'input[placeholder*="Kayıtlar içinde"], ' +
        'input[placeholder*="Ara"]'
      ).first();
      await inp.fill('');
      await inp.type(filters.search.trim(), { delay: 40 });
      logger.info('Arama filtresi: ' + filters.search);
    } catch(e) {
      logger.warn('Arama filtresi hatası: ' + e.message);
    }
  }

  // "Ara" butonuna tıkla
  if (hasDate || hasSearch) {
    try {
      await page.locator('button:has-text("Ara")').first().click({ timeout: 5000 });
      logger.info('"Ara" butonuna tıklandı');
      await humanDelay(2000, 2800);

      // Session kopmuş olabilir — URL kontrol et
      const urlAfterAra = page.url();
      if (urlAfterAra.includes('login') || urlAfterAra.includes('giris') || !urlAfterAra.includes('validation')) {
        if (_retry < 2) {
          logger.warn('"Ara" sonrası session koptu, yeniden login + filtre...');
          await shot(page, '5-session-expired');
          await refreshSession(page);
          return applyPortalFilters(page, filters, _retry + 1);
        }
        logger.warn('Session yenilenemedi, 0 döndürülüyor');
        return 0;
      }

      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
    } catch(e) {
      logger.warn('"Ara" butonu: ' + e.message);
      await humanDelay(2000, 3000);
    }
    await shot(page, '5-results');
  }

  const total = await _getTotalCount(page);
  logger.info('Portal filtre sonucu: ' + total + ' kayıt');
  return total;
}

// Takvimde belirtilen ay/yıla git
// Portal'daki takvim Mart/2026 gibi dropdown select kullanıyor — direkt seç
async function navigateToMonth(page, targetMonth, targetYear) {
  // Türkçe ay ismi → index (1=Ocak...12=Aralık)
  // Select option value genellikle 0-indexed (0=Ocak) veya ay adı
  // Önce dropdown (select) ile dene
  const calSel = '[class*="picker"], [class*="calendar"], [class*="daterange"], .datepicker';

  // Yıl select
  const yearSet = await page.evaluate((targetYear, calSel) => {
    const picker = document.querySelector(calSel);
    if (!picker) return false;
    const selects = picker.querySelectorAll('select');
    for (const sel of selects) {
      // Yıl select: options 2020-2030 gibi 4 haneli değerler
      const opts = Array.from(sel.options);
      if (opts.some(o => /^\d{4}$/.test(o.value) && parseInt(o.value) >= 2020)) {
        const opt = opts.find(o => parseInt(o.value) === targetYear);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
    }
    return false;
  }, targetYear, calSel);

  if (yearSet) await humanDelay(200, 400);

  // Ay select (0-indexed veya 1-indexed)
  const monthSet = await page.evaluate((targetMonth, calSel, AYLAR) => {
    const picker = document.querySelector(calSel);
    if (!picker) return false;
    const selects = picker.querySelectorAll('select');
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      // Ay ismi ile eşleş
      const byName = opts.findIndex(o => AYLAR.includes(o.text.trim()) || AYLAR.includes(o.value));
      if (byName >= 0) {
        // 0-indexed: targetMonth-1, 1-indexed: targetMonth
        const zeroOpt = opts.find(o => parseInt(o.value) === targetMonth - 1);
        const oneOpt  = opts.find(o => parseInt(o.value) === targetMonth);
        const nameOpt = opts.find(o => o.text.trim() === AYLAR[targetMonth]);
        const target  = zeroOpt || nameOpt || oneOpt;
        if (target) { sel.value = target.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
    }
    return false;
  }, targetMonth, calSel, AYLAR);

  if (monthSet) { await humanDelay(200, 400); return; }

  // Dropdown çalışmadıysa — buton ile ilerle/geri git
  logger.warn('navigateToMonth: dropdown bulunamadı, buton navigasyonu deneniyor');
  for (let i = 0; i < 36; i++) {
    const headerText = await page.evaluate((calSel) => {
      const picker = document.querySelector(calSel);
      return picker ? picker.textContent.substring(0, 80) : '';
    }, calSel);

    const currentMonth = AYLAR.findIndex(a => a && headerText.includes(a));
    const yilMatch = headerText.match(/\d{4}/);
    const currentYear = yilMatch ? parseInt(yilMatch[0]) : 0;
    if (currentMonth > 0 && currentMonth === targetMonth && currentYear === targetYear) break;

    const cur = currentYear * 12 + Math.max(currentMonth, 1);
    const tgt = targetYear * 12 + targetMonth;

    if (tgt > cur) {
      await page.locator(calSel + ' button').last().click({ timeout: 1000 }).catch(() => {});
    } else {
      await page.locator(calSel + ' button').first().click({ timeout: 1000 }).catch(() => {});
    }
    await humanDelay(300, 500);
  }
}

// Takvimde belirtilen güne tıkla (exact match, disabled/off olmayanlar)
async function clickDay(page, day) {
  const clicked = await page.evaluate((targetDay) => {
    const dayStr = String(targetDay);
    // Olası selektörler: td, button, div, span ile gün hücreleri
    const cells = Array.from(document.querySelectorAll(
      'td, button, [class*="day"], [class*="date"], [class*="cell"]'
    ));

    for (const cell of cells) {
      const text = cell.textContent.trim();
      if (text !== dayStr) continue;

      // Disabled/off/other-month olan hücreleri atla
      const cls = (cell.className || '').toString().toLowerCase();
      if (cls.includes('disabled') || cls.includes('off') ||
          cls.includes('other') || cls.includes('muted') ||
          cell.hasAttribute('disabled')) continue;

      // Takvim popup içinde mi?
      const inPicker = cell.closest(
        '[class*="picker"], [class*="calendar"], [class*="daterange"], .datepicker'
      );
      if (!inPicker) continue;

      cell.click();
      return true;
    }
    return false;
  }, day);

  if (!clicked) {
    logger.warn('Gün tıklanamadı: ' + day + ', Playwright locator deneniyor...');
    // Fallback: Playwright locator
    try {
      await page.locator(
        `[class*="picker"] td:not(.disabled):not(.off), ` +
        `[class*="calendar"] td:not(.disabled):not(.off), ` +
        `[class*="picker"] [class*="day"]:not(.disabled):not(.off)`
      ).filter({ hasText: new RegExp('^' + day + '$') }).first().click({ timeout: 3000 });
    } catch(e) {
      logger.warn('Gün locator hatası: ' + e.message);
    }
  }
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
 */
async function sendBulkSMS(page, filters, onProgress, checkPauseStop) {
  let sent = 0, skipped = 0, failed = 0;
  // Bugün 2+ kez gönderilmiş ref'ler — tekrar gönderilmez
  const { getTodayBlockedRefs } = require('./db');
  const blockedRefs = getTodayBlockedRefs();
  if (blockedRefs.size > 0) logger.info('Bugün limit dolmuş (2x): ' + blockedRefs.size + ' ref atlanacak');

  const total = await applyPortalFilters(page, filters || {});

  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });

  const totalPages = await _getTotalPages(page);
  logger.info('SMS tarama başladı: ' + total + ' kayıt, ' + totalPages + ' sayfa (rows/page: ' + Math.ceil(total / (totalPages || 1)) + ')');

  // Portal her SMS sonrası tabloyu re-render edebilir → eski row handle'ları geçersiz olur.
  // Çözüm: her SMS öncesi tabloyu taze sorgula, işlenenleri Set ile takip et.
  const processedRefs = new Set();
  let pageNum = 1;
  let noNewConsecutive = 0;

  while (sent + skipped + failed < total) {
    if (checkPauseStop) await checkPauseStop();

    // Taze sorgu
    const rows = await page.$$('[class*="rdt_TableRow"]').catch(() => []);

    // Bu sayfada işlenmemiş ilk satırı bul
    let foundNew = false;
    for (const row of rows) {
      let cells;
      try { cells = await row.$$('[class*="rdt_TableCell"]'); } catch { continue; }
      if (cells.length < 8) continue;

      let ref;
      try { ref = ((await cells[0].textContent()) || '').trim(); } catch { continue; }
      if (!ref || processedRefs.has(ref)) continue;

      processedRefs.add(ref);
      foundNew = true;
      noNewConsecutive = 0;

      // Günlük limit
      if (blockedRefs.has(ref)) {
        skipped++;
        logger.info('Günlük limit (2x): ' + ref + ' atlandı');
        if (onProgress) onProgress({ ref, status: 'daily-limit', gonderilenSms: 0, manuelLimit: 0, sent, skipped, failed, total });
        break;
      }

      let gonderilenSms, manuelLimit;
      try {
        gonderilenSms = parseInt(((await cells[6].textContent()) || '0').trim()) || 0;
        manuelLimit   = parseInt(((await cells[7].textContent()) || '0').trim()) || 0;
      } catch { gonderilenSms = 0; manuelLimit = 0; }

      if (manuelLimit > 0 && gonderilenSms >= manuelLimit) {
        logger.warn('SMS limiti dolu: ' + ref + ' (' + gonderilenSms + '/' + manuelLimit + ')');
        skipped++;
        if (onProgress) onProgress({ ref, status: 'limit', gonderilenSms, manuelLimit, sent, skipped, failed, total });
        break;
      }

      let smsBtn;
      try { smsBtn = await row.$('.btn-primary, button:has-text("SMS Gönder")'); } catch { smsBtn = null; }
      if (!smsBtn) {
        logger.warn('SMS butonu yok: ' + ref);
        skipped++;
        break;
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
          success = true;
        }

        if (success) {
          sent++;
          await humanDelay(400, 600);
          let sonKullanimTarihi = null, yeniGonderilenSms = gonderilenSms;
          try {
            const uc = await row.$$('[class*="rdt_TableCell"]');
            if (uc[9]) sonKullanimTarihi = ((await uc[9].textContent()) || '').trim() || null;
            if (uc[6]) yeniGonderilenSms = parseInt(((await uc[6].textContent()) || '0').trim()) || gonderilenSms;
          } catch {}
          logger.info('SMS gönderildi: ' + ref + (sonKullanimTarihi ? ' | son: ' + sonKullanimTarihi : ''));
          if (onProgress) onProgress({ ref, status: 'ok', gonderilenSms: yeniGonderilenSms, manuelLimit, sonKullanimTarihi, sent, skipped, failed, total });
        } else {
          failed++;
          if (onProgress) onProgress({ ref, status: 'error', gonderilenSms, manuelLimit, sent, skipped, failed, total });
          await humanDelay(400, 700);
        }
      } catch(e) {
        logger.warn('SMS tıklama hatası ' + ref + ': ' + e.message);
        failed++;
        if (onProgress) onProgress({ ref, status: 'error', error: e.message, gonderilenSms, manuelLimit, sent, skipped, failed, total });
      }
      break; // Her iterasyonda bir satır işle, sonra taze sorgu
    }

    if (!foundNew) {
      // Bu sayfada işlenecek yeni kayıt yok → sonraki sayfaya geç
      noNewConsecutive++;
      if (noNewConsecutive > 3) break; // Art arda 3 boş sayfa → dur

      if (pageNum >= totalPages) break;

      const prevRef = await page.$eval('[class*="rdt_TableRow"] [class*="rdt_TableCell"]', el => el.textContent.trim()).catch(() => '');
      const clicked = await _clickNext(page);
      if (!clicked) break;

      try {
        await page.waitForFunction(
          (prev) => {
            const c = document.querySelector('[class*="rdt_TableRow"] [class*="rdt_TableCell"]');
            return c && c.textContent.trim() !== prev;
          },
          prevRef, { timeout: 12000 }
        );
      } catch { await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); }

      // Session kontrol
      const urlAfterNext = page.url();
      if (urlAfterNext.includes('login') || !urlAfterNext.includes('validation')) {
        logger.warn('SMS sayfa geçişinde session koptu (sayfa ' + pageNum + '), kurtarma...');
        await refreshSession(page);
        await applyPortalFilters(page, filters || {}, 2);
        await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
        for (let p = 0; p < pageNum; p++) {
          await _clickNext(page);
          await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 8000 }).catch(() => {});
          await humanDelay(400, 600);
        }
      }

      pageNum++;
      await humanDelay(300, 500);
    }
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
  // Pagination görünene kadar bekle (React render sonrası kaybolabilir)
  try {
    await page.waitForSelector('[class*="rdt_Pagination"] button', { timeout: 8000 });
  } catch(e) {
    logger.warn('_clickNext: pagination bekleme timeout');
    return false;
  }

  try {
    const btns = await page.$$('[class*="rdt_Pagination"] button');
    const active = [];
    for (const b of btns) {
      if (!(await b.isDisabled())) active.push(b);
    }
    logger.info('_clickNext: btn=' + btns.length + ' aktif=' + active.length);

    // aria-label ile "next" bul
    for (const b of active) {
      const label = (await b.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('next') || label.includes('sonraki') || label.includes('ileri')) {
        await b.click(); return true;
      }
    }
    // Text ile bul
    for (const b of active) {
      const t = ((await b.textContent()) || '').trim();
      if (t === '>' || t === '›' || t === 'Next' || t === 'Sonraki') {
        await b.click(); return true;
      }
    }
    // Fallback: active sondan 2. (genellikle Next, son = Last)
    if (active.length >= 2) { await active[active.length - 2].click(); return true; }
    if (active.length === 1) { await active[0].click(); return true; }
  } catch(e) { logger.warn('_clickNext hata: ' + e.message); }
  return false;
}

module.exports = { sendBulkSMS, applyPortalFilters };
