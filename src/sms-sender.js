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

// Takvimde ay select'ini bulur (calSel bağımsız, global arama)
function _findMonthSelect() {
  const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                     'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  return Array.from(document.querySelectorAll('select')).find(s => {
    const opts = Array.from(s.options);
    return opts.length >= 11 && opts.some(o => TR_MONTHS.includes(o.text.trim()));
  }) || null;
}

// Takvimde belirtilen ay/yıla git
// calSel bağımsız: ay <select> global aranır, yıl için bounding rect ile prev/next buton bulunur
async function navigateToMonth(page, targetMonth, targetYear) {
  // Step 1: Ay select ile hedef ayı seç
  const monthSetResult = await page.evaluate((targetMonth, AYLAR) => {
    const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                       'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const sel = Array.from(document.querySelectorAll('select')).find(s => {
      const opts = Array.from(s.options);
      return opts.length >= 11 && opts.some(o => TR_MONTHS.includes(o.text.trim()));
    });
    if (!sel) return { set: false };
    const opts = Array.from(sel.options);
    const byName = opts.find(o => o.text.trim() === AYLAR[targetMonth]);
    const by0    = opts.find(o => parseInt(o.value) === targetMonth - 1);
    const by1    = opts.find(o => parseInt(o.value) === targetMonth);
    const target = byName || by0 || by1;
    if (!target) return { set: false };
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { set: true, value: target.value };
  }, targetMonth, AYLAR);

  if (monthSetResult.set) {
    logger.info('navigateToMonth: ay seçildi → ' + AYLAR[targetMonth] + ' (value:' + monthSetResult.value + ')');
    await humanDelay(300, 500);
  } else {
    logger.warn('navigateToMonth: ay select bulunamadı');
  }

  // Step 2: Yıl kontrolü — ay select'in yanındaki metinden yılı oku
  // Ardından prev/next butonlara bounding rect ile tıkla
  for (let i = 0; i < 24; i++) {
    const state = await page.evaluate(() => {
      const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                         'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
      const sel = Array.from(document.querySelectorAll('select')).find(s => {
        const opts = Array.from(s.options);
        return opts.length >= 11 && opts.some(o => TR_MONTHS.includes(o.text.trim()));
      });
      if (!sel) return null;
      const selRect = sel.getBoundingClientRect();
      // Yıl: select'in parent container'ındaki 4 haneli sayı
      let container = sel.parentElement;
      let curYear = 0;
      for (let j = 0; j < 5 && container; j++) {
        const m = container.textContent.match(/\b(20\d{2})\b/);
        if (m) { curYear = parseInt(m[1]); break; }
        container = container.parentElement;
      }
      // Tüm butonlar arasında select'in solunda (prev) ve sağında (next) olanları bul
      const allBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        if (b.disabled) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 &&
               Math.abs(r.top + r.height / 2 - (selRect.top + selRect.height / 2)) < 40;
      });
      const prevBtn = allBtns.filter(b => b.getBoundingClientRect().right <= selRect.left)
                              .sort((a,b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      const nextBtn = allBtns.filter(b => b.getBoundingClientRect().left >= selRect.right)
                              .sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      return { curYear, hasPrev: !!prevBtn, hasNext: !!nextBtn };
    });

    if (!state) { logger.warn('navigateToMonth: calendar state okunamadı'); break; }
    if (state.curYear === targetYear) break;

    logger.info('navigateToMonth: curYear=' + state.curYear + ' → targetYear=' + targetYear + ' (iter ' + i + ')');

    const goForward = targetYear > state.curYear;
    const clicked = await page.evaluate((goForward) => {
      const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                         'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
      const sel = Array.from(document.querySelectorAll('select')).find(s => {
        const opts = Array.from(s.options);
        return opts.length >= 11 && opts.some(o => TR_MONTHS.includes(o.text.trim()));
      });
      if (!sel) return false;
      const selRect = sel.getBoundingClientRect();
      const allBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        if (b.disabled) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 &&
               Math.abs(r.top + r.height / 2 - (selRect.top + selRect.height / 2)) < 40;
      });
      let btn;
      if (goForward) {
        btn = allBtns.filter(b => b.getBoundingClientRect().left >= selRect.right)
                     .sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      } else {
        btn = allBtns.filter(b => b.getBoundingClientRect().right <= selRect.left)
                     .sort((a,b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      }
      if (btn) { btn.click(); return true; }
      return false;
    }, goForward);

    if (!clicked) {
      logger.warn('navigateToMonth: buton tıklanamadı (iter ' + i + ')');
      break;
    }
    await humanDelay(350, 550);
  }
}

// Takvimde belirtilen güne tıkla
// Calendar container'ı month select'in parent table'ından bulur (calSel bağımsız)
async function clickDay(page, day) {
  const clicked = await page.evaluate((targetDay) => {
    const dayStr = String(targetDay);
    const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                       'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

    // Month select'i bul → parent container'ını bul → içindeki table'ı bul
    const monthSel = Array.from(document.querySelectorAll('select')).find(s => {
      const opts = Array.from(s.options);
      return opts.length >= 11 && opts.some(o => TR_MONTHS.includes(o.text.trim()));
    });

    let calTable = null;
    if (monthSel) {
      let el = monthSel.parentElement;
      for (let i = 0; i < 6 && el; i++) {
        const t = el.querySelector('table');
        if (t) { calTable = t; break; }
        el = el.parentElement;
      }
    }

    // Calendar table içindeki hücreler
    const searchRoot = calTable || document;
    const cells = Array.from(searchRoot.querySelectorAll('td, [role="gridcell"], [class*="day"], button'));

    for (const cell of cells) {
      if (cell.textContent.trim() !== dayStr) continue;
      const cls = (cell.className || '').toString().toLowerCase();
      if (cls.includes('disabled') || cls.includes('off') ||
          cls.includes('other') || cls.includes('muted') ||
          cell.hasAttribute('disabled')) continue;
      // Main data table'dan ayırt et: ana tablo hücreleri çok fazla içerik içerir
      if (!calTable) {
        const parentTable = cell.closest('table');
        if (parentTable && parentTable.querySelectorAll('td').length > 40) continue;
      }
      cell.click();
      return true;
    }
    return false;
  }, day);

  if (!clicked) {
    logger.warn('clickDay: ' + day + ' bulunamadı, getByRole deneniyor...');
    try {
      await page.getByRole('gridcell', { name: String(day), exact: true }).first().click({ timeout: 2000 });
    } catch {
      try {
        await page.locator('table td').filter({ hasText: new RegExp('^' + day + '$') }).first().click({ timeout: 2000 });
      } catch(e) {
        logger.warn('clickDay son hata: ' + e.message);
      }
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
