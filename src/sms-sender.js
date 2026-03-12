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

const TR_MONTHS_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;

// Month select locator — sayfadaki Türkçe ay seçenekli <select>
async function _getMonthSelectBox(page) {
  const sels = page.locator('select');
  const n = await sels.count();
  for (let i = 0; i < n; i++) {
    const s = sels.nth(i);
    const opts = await s.locator('option').allTextContents().catch(() => []);
    if (opts.some(o => TR_MONTHS_RX.test(o.trim()))) return s;
  }
  return null;
}

// Takvimde belirtilen ay/yıla git
// page.selectOption() ile React select tetiklenir; yıl navigasyonu bounding box ile buton tıklar
async function navigateToMonth(page, targetMonth, targetYear) {
  const monthSel = await _getMonthSelectBox(page);
  if (!monthSel) {
    logger.warn('navigateToMonth: ay select bulunamadı');
    return;
  }

  // Mevcut ay/yıl oku
  const opts = await monthSel.locator('option').allTextContents();
  const curValue = await monthSel.inputValue().catch(() => '');
  let curMonth = 0;
  const byVal  = opts.findIndex((_, i) => String(i) === curValue || String(i - 1) === curValue);
  if (byVal >= 0) curMonth = byVal + 1;
  else {
    const byText = opts.findIndex(o => TR_MONTHS_RX.test(o.trim()) && o.trim() === opts[parseInt(curValue)]?.trim());
    const direct = AYLAR.indexOf((opts[parseInt(curValue)] || '').trim());
    curMonth = direct > 0 ? direct : (parseInt(curValue) + 1) || 1;
  }

  const selBox  = await monthSel.boundingBox();
  const curYear = await page.evaluate(({ x, y, w }) => {
    // Select'in sağındaki/yakınındaki 4 haneli yıl metnini bul
    const el = document.elementFromPoint(x + w + 60, y + 8);
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const m = node.textContent.match(/\b(20\d{2})\b/);
      if (m) return parseInt(m[1]);
      node = node.parentElement;
    }
    return 0;
  }, { x: selBox.x, y: selBox.y, w: selBox.width });

  logger.info('navigateToMonth: şu an ' + (AYLAR[curMonth] || curMonth) + ' ' + curYear +
              ' → hedef ' + AYLAR[targetMonth] + ' ' + targetYear);

  // Delta ay (negatif = geriye, pozitif = ileriye)
  const delta = (targetYear * 12 + targetMonth) - ((curYear || 2026) * 12 + curMonth);
  if (delta === 0) return;

  const steps = Math.abs(delta);
  const goForward = delta > 0;

  for (let i = 0; i < steps; i++) {
    // Her adımda güncel select box'ı al (sayfa yeniden render olabilir)
    const mSel = await _getMonthSelectBox(page);
    const mBox = mSel ? await mSel.boundingBox() : selBox;

    // Select'in solunda (prev) veya sağında (next) en yakın buton
    const allBtns = page.locator('button');
    const btnN    = await allBtns.count();
    let best = null, bestDist = Infinity;
    const midY = mBox.y + mBox.height / 2;

    for (let j = 0; j < btnN; j++) {
      const b = allBtns.nth(j);
      const box = await b.boundingBox().catch(() => null);
      if (!box || box.width < 4) continue;
      if (Math.abs((box.y + box.height / 2) - midY) > 35) continue; // aynı yükseklikte değil

      let dist = Infinity;
      if (goForward && box.x >= mBox.x + mBox.width - 5) {
        dist = box.x - (mBox.x + mBox.width);
      } else if (!goForward && box.x + box.width <= mBox.x + 5) {
        dist = mBox.x - (box.x + box.width);
      }
      if (dist < bestDist) { bestDist = dist; best = b; }
    }

    if (best) {
      await best.click();
      await humanDelay(280, 420);
    } else {
      logger.warn('navigateToMonth: buton bulunamadı (adım ' + i + '/' + steps + ')');
      break;
    }
  }

  // Sonuç kontrolü
  const finalSel = await _getMonthSelectBox(page);
  if (finalSel) {
    const finalVal  = await finalSel.inputValue().catch(() => '?');
    const finalYear = await page.evaluate(({ x, y, w }) => {
      const el = document.elementFromPoint(x + w + 60, y + 8);
      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        const m = node.textContent.match(/\b(20\d{2})\b/);
        if (m) return parseInt(m[1]);
        node = node.parentElement;
      }
      return 0;
    }, await (async () => { const b = await finalSel.boundingBox(); return { x: b.x, y: b.y, w: b.width }; })());
    const idx = parseInt(finalVal);
    const finalMonthName = !isNaN(idx) ? (AYLAR[idx + 1] || AYLAR[idx] || finalVal) : finalVal;
    logger.info('navigateToMonth: sonuç → ' + finalMonthName + ' ' + finalYear);
  }
}

// Takvimde belirtilen güne tıkla
// Month select'in bounding box'ını referans alarak calendar alanındaki gün hücrelerini bulur
async function clickDay(page, day) {
  const dayStr = String(day);

  // Month select'in konumunu bul → calendar alanı bunun altında
  const mSel = await _getMonthSelectBox(page);
  const mBox = mSel ? await mSel.boundingBox().catch(() => null) : null;

  // td ve gridcell elementleri — exact text match, disabled olmayan
  const candidates = page.locator('td, [role="gridcell"]').filter({
    hasText: new RegExp('^' + dayStr + '$'),
  });
  const cnt = await candidates.count();

  for (let i = 0; i < cnt; i++) {
    const cell = candidates.nth(i);
    const cls  = (await cell.getAttribute('class').catch(() => '') || '').toLowerCase();
    if (cls.includes('disabled') || cls.includes('off') || cls.includes('other') || cls.includes('muted')) continue;
    if (await cell.isDisabled().catch(() => false)) continue;

    // Eğer month select bulunduysa, hücrenin calendar alanında olup olmadığını kontrol et
    if (mBox) {
      const cBox = await cell.boundingBox().catch(() => null);
      if (!cBox) continue;
      // Calendar hücreleri: select'in altında ve yatay olarak yakın
      if (cBox.y < mBox.y + 5) continue;         // select'in üstünde
      if (cBox.x < mBox.x - 300) continue;       // çok sola kaçmış
      if (cBox.x > mBox.x + mBox.width + 300) continue; // çok sağa kaçmış
    }

    await cell.click();
    logger.info('clickDay: ' + day + ' tıklandı');
    return;
  }

  // Fallback
  logger.warn('clickDay: ' + day + ' konumsal bulunamadı, getByRole deneniyor...');
  try {
    await page.getByRole('gridcell', { name: dayStr, exact: true }).first().click({ timeout: 2000 });
  } catch {
    try {
      await page.locator('table td').filter({ hasText: new RegExp('^' + dayStr + '$') }).first().click({ timeout: 2000 });
    } catch(e) {
      logger.warn('clickDay hata: ' + e.message);
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
