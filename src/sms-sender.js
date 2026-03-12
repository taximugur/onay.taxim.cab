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
  // Tarih filtresi varsa — portal calendar yerine direkt DB'den say
  const { countByDateRange } = require('./db');
  if (filters.kayitStart && filters.kayitEnd) {
    const dbCount = countByDateRange(filters.kayitStart, filters.kayitEnd);
    logger.info('DB filtre sayımı: ' + dbCount + ' kayıt (' + filters.kayitStart + ' — ' + filters.kayitEnd + ')');
    return dbCount;
  }

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

      // Calendar DOM'unu kaydet (debug)
      try {
        const calHtml = await page.content();
        fs.writeFileSync('data/cal-open.html', calHtml);
        // Calendar structure debug
        const dbg = await page.evaluate(() => {
          const TR_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;
          const sel = Array.from(document.querySelectorAll('select'))
            .find(s => Array.from(s.options).some(o => TR_RX.test(o.text.trim())));
          if (!sel) return 'select not found';
          const parent = sel.parentElement;
          const gp = parent ? parent.parentElement : null;
          const ggp = gp ? gp.parentElement : null;
          return {
            selClass: sel.className,
            parentTag: parent ? parent.tagName + '.' + parent.className.slice(0,40) : '-',
            parentText: parent ? parent.textContent.slice(0,80) : '-',
            gpTag: gp ? gp.tagName + '.' + gp.className.slice(0,40) : '-',
            gpText: gp ? gp.textContent.slice(0,80) : '-',
            ggpTag: ggp ? ggp.tagName + '.' + ggp.className.slice(0,40) : '-',
            ggpText: ggp ? ggp.textContent.slice(0,80) : '-',
            btnsNear: Array.from(document.querySelectorAll('button')).map(b => {
              const r = b.getBoundingClientRect();
              const sr = sel.getBoundingClientRect();
              return { text: b.textContent.trim().slice(0,15), cls: b.className.slice(0,30), left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vd: Math.round(Math.abs((r.top+r.height/2)-(sr.top+sr.height/2))) };
            }).filter(b => b.vd < 80 && b.w > 0).slice(0, 10)
          };
        });
        logger.info('CAL_DEBUG: ' + JSON.stringify(dbg));
      } catch(e) { logger.warn('cal debug: ' + e.message); }

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
// Tüm DOM işlemleri tek page.evaluate çağrısı ile — Playwright boundingBox yerine
// getBoundingClientRect() kullanılır. Single-arg wrapped object ile "Too many arguments" yok.
async function navigateToMonth(page, targetMonth, targetYear) {
  // Mevcut ay/yıl oku (no-arg evaluate)
  const state = await page.evaluate(() => {
    const TR_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;
    const sel = Array.from(document.querySelectorAll('select'))
      .find(s => Array.from(s.options).some(o => TR_RX.test(o.text.trim())));
    if (!sel) return null;
    // Seçili option'ın text'inden ay
    const selOpt = sel.options[sel.selectedIndex];
    const monthText = selOpt ? selOpt.text.trim() : '';
    const MONTHS = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const curMonth = MONTHS.indexOf(monthText);
    // Yıl: select'in parent tree'sinden bul
    let el = sel.parentElement;
    let curYear = 0;
    for (let i = 0; i < 8 && el; i++) {
      const m = el.textContent.match(/\b(20\d{2})\b/);
      if (m) { curYear = parseInt(m[1]); break; }
      el = el.parentElement;
    }
    return { curMonth, curYear };
  });

  if (!state) { logger.warn('navigateToMonth: calendar state okunamadı'); return; }

  const { curMonth, curYear } = state;
  logger.info('navigateToMonth: ' + (AYLAR[curMonth]||curMonth) + ' ' + (curYear||'?') +
              ' → ' + AYLAR[targetMonth] + ' ' + targetYear);

  const delta = (targetYear * 12 + targetMonth) - ((curYear || 2026) * 12 + (curMonth || 3));
  if (delta === 0) return;

  const steps    = Math.abs(delta);
  const goFwd    = delta > 0;

  for (let i = 0; i < steps; i++) {
    // Her adımda DOM içinde getBoundingClientRect ile buton bul ve tıkla
    const clicked = await page.evaluate(({ goFwd }) => {
      const TR_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;
      const sel = Array.from(document.querySelectorAll('select'))
        .find(s => Array.from(s.options).some(o => TR_RX.test(o.text.trim())));
      if (!sel) return false;
      const sr = sel.getBoundingClientRect();
      const buttons = Array.from(document.querySelectorAll('button'));
      let best = null, bestDist = Infinity;
      for (const btn of buttons) {
        const r = btn.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const vd = Math.abs((r.top + r.height / 2) - (sr.top + sr.height / 2));
        if (vd > 60) continue;
        let d;
        if (goFwd  && r.left  >= sr.right - 5)  d = r.left  - sr.right;
        else if (!goFwd && r.right <= sr.left  + 5)  d = sr.left  - r.right;
        else continue;
        if (d >= 0 && d < bestDist) { bestDist = d; best = btn; }
      }
      if (best) { best.click(); return true; }
      // Debug: log what we found
      const near = buttons.filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && Math.abs((r.top + r.height/2) - (sr.top + sr.height/2)) < 60;
      }).map(b => ({ text: b.textContent.trim().slice(0,10), left: Math.round(b.getBoundingClientRect().left), right: Math.round(b.getBoundingClientRect().right) }));
      console.log('NAV_BTN_DEBUG selRight=' + Math.round(sr.right) + ' selLeft=' + Math.round(sr.left) + ' nearBtns=' + JSON.stringify(near));
      return false;
    }, { goFwd });

    if (!clicked) {
      logger.warn('navigateToMonth: buton tıklanamadı (adım ' + (i+1) + '/' + steps + ')');
      break;
    }
    await humanDelay(300, 450);
  }

  // Sonuç log
  const final = await page.evaluate(() => {
    const TR_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;
    const sel = Array.from(document.querySelectorAll('select'))
      .find(s => Array.from(s.options).some(o => TR_RX.test(o.text.trim())));
    if (!sel) return null;
    const selOpt = sel.options[sel.selectedIndex];
    let el = sel.parentElement, yr = 0;
    for (let i = 0; i < 8 && el; i++) {
      const m = el.textContent.match(/\b(20\d{2})\b/);
      if (m) { yr = parseInt(m[1]); break; }
      el = el.parentElement;
    }
    return { month: selOpt ? selOpt.text.trim() : '?', year: yr };
  });
  if (final) logger.info('navigateToMonth: sonuç → ' + final.month + ' ' + final.year);
}

// Takvimde belirtilen güne tıkla
// page.evaluate içinde getBoundingClientRect ile calendar hücresini bulur
async function clickDay(page, day) {
  const clicked = await page.evaluate(({ day }) => {
    const dayStr = String(day);
    const TR_RX = /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)$/;
    const sel = Array.from(document.querySelectorAll('select'))
      .find(s => Array.from(s.options).some(o => TR_RX.test(o.text.trim())));
    const sr = sel ? sel.getBoundingClientRect() : null;

    const cells = Array.from(document.querySelectorAll('td, [role="gridcell"]'));
    for (const cell of cells) {
      if (cell.textContent.trim() !== dayStr) continue;
      const cls = (cell.className || '').toLowerCase();
      if (cls.includes('disabled') || cls.includes('off') ||
          cls.includes('other') || cls.includes('muted') ||
          cell.hasAttribute('disabled')) continue;
      if (sr) {
        const r = cell.getBoundingClientRect();
        if (r.top < sr.top) continue;            // select'in üstünde → takvim dışı
        if (Math.abs(r.left - sr.left) > 350) continue; // çok uzakta → ana tablo
      }
      cell.click();
      return true;
    }
    return false;
  }, { day });

  if (!clicked) {
    logger.warn('clickDay: ' + day + ' bulunamadı');
    try {
      await page.locator('table td').filter({ hasText: new RegExp('^' + day + '$') }).first().click({ timeout: 2000 });
    } catch(e) {
      logger.warn('clickDay hata: ' + e.message);
    }
  } else {
    logger.info('clickDay: ' + day + ' tıklandı');
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
 * Tarih filtresi varsa DB'den targetRefs alır, portal tam listesini sayfa sayfa tarar.
 */
async function sendBulkSMS(page, filters, onProgress, checkPauseStop) {
  let sent = 0, skipped = 0, failed = 0;
  const { getTodayBlockedRefs, getRefsByDateRange } = require('./db');
  const blockedRefs = getTodayBlockedRefs();
  if (blockedRefs.size > 0) logger.info('Bugün limit dolmuş (2x): ' + blockedRefs.size + ' ref atlanacak');

  let targetRefs = null;
  if (filters && filters.kayitStart && filters.kayitEnd) {
    targetRefs = getRefsByDateRange(filters.kayitStart, filters.kayitEnd);
    logger.info('DB filtresi aktif: ' + targetRefs.size + ' hedef ref (' + filters.kayitStart + ' — ' + filters.kayitEnd + ')');
  }

  if (targetRefs) {
    // Filtresiz tam portal listesi — page.goto ile filtre temizle (navigateToApprovalPage erken çıkıyor)
    const base = new URL(page.url()).origin;
    await page.goto(base + '/validation-waiting-records', { waitUntil: 'networkidle', timeout: 30000 });
  } else {
    await applyPortalFilters(page, filters || {});
  }

  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });

  const totalPages = await _getTotalPages(page);
  const portalTotal = await _getTotalCount(page);
  const effectiveTotal = targetRefs ? targetRefs.size : portalTotal;
  logger.info('SMS tarama başladı: hedef=' + effectiveTotal + ' kayıt, portal=' + portalTotal + ', ' + totalPages + ' sayfa');

  const processedRefs = new Set();

  pageLoop: for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (checkPauseStop) await checkPauseStop();

    await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 }).catch(() => {});
    const rows = await page.$$('[class*="rdt_TableRow"]').catch(() => []);

    for (const row of rows) {
      if (checkPauseStop) await checkPauseStop();

      let cells;
      try { cells = await row.$$('[class*="rdt_TableCell"]'); } catch { continue; }
      if (cells.length < 8) continue;

      let ref;
      try { ref = ((await cells[0].textContent()) || '').trim(); } catch { continue; }
      if (!ref || processedRefs.has(ref)) continue;
      processedRefs.add(ref);

      // DB tarih filtresi — eşleşmiyorsa bu sayfada sonraki satıra geç
      if (targetRefs && !targetRefs.has(ref)) continue;

      // Günlük limit
      if (blockedRefs.has(ref)) {
        skipped++;
        logger.info('Günlük limit (2x): ' + ref + ' atlandı');
        if (onProgress) onProgress({ ref, status: 'daily-limit', gonderilenSms: 0, manuelLimit: 0, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      let gonderilenSms, manuelLimit;
      try {
        gonderilenSms = parseInt(((await cells[6].textContent()) || '0').trim()) || 0;
        manuelLimit   = parseInt(((await cells[7].textContent()) || '0').trim()) || 0;
      } catch { gonderilenSms = 0; manuelLimit = 0; }

      if (manuelLimit > 0 && gonderilenSms >= manuelLimit) {
        skipped++;
        logger.warn('SMS limiti dolu: ' + ref + ' (' + gonderilenSms + '/' + manuelLimit + ')');
        if (onProgress) onProgress({ ref, status: 'limit', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      // Locator ile taze sorgu — stale ElementHandle'dan kaçın
      const smsBtnLocator = page.locator('[class*="rdt_TableRow"]')
        .filter({ hasText: ref })
        .locator('.btn-primary, button:has-text("SMS Gönder")')
        .first();
      const btnVisible = await smsBtnLocator.isVisible().catch(() => false);
      if (!btnVisible) {
        skipped++;
        logger.warn('SMS butonu yok: ' + ref);
        if (onProgress) onProgress({ ref, status: 'no-btn', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      try {
        const [response] = await Promise.all([
          page.waitForResponse(
            r => r.url().includes('reSendSms') || r.url().includes('sendSms'),
            { timeout: 10000 }
          ).catch(() => null),
          smsBtnLocator.click({ timeout: 5000 }),
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
            const freshCells = await page.locator('[class*="rdt_TableRow"]')
              .filter({ hasText: ref })
              .locator('[class*="rdt_TableCell"]').all();
            if (freshCells[9]) sonKullanimTarihi = ((await freshCells[9].textContent()) || '').trim() || null;
            if (freshCells[6]) yeniGonderilenSms = parseInt(((await freshCells[6].textContent()) || '0').trim()) || gonderilenSms;
          } catch {}
          logger.info('SMS gönderildi: ' + ref + (sonKullanimTarihi ? ' | son: ' + sonKullanimTarihi : ''));
          if (onProgress) onProgress({ ref, status: 'ok', gonderilenSms: yeniGonderilenSms, manuelLimit, sonKullanimTarihi, sent, skipped, failed, total: effectiveTotal });
        } else {
          failed++;
          if (onProgress) onProgress({ ref, status: 'error', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
          await humanDelay(400, 700);
        }
      } catch(e) {
        logger.warn('SMS tıklama hatası ' + ref + ': ' + e.message);
        failed++;
        if (onProgress) onProgress({ ref, status: 'error', error: e.message, gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
      }

      if (sent + skipped + failed >= effectiveTotal) break pageLoop;
    }

    if (pageNum >= totalPages) break;

    const prevRef = await page.$eval(
      '[class*="rdt_TableRow"] [class*="rdt_TableCell"]',
      el => el.textContent.trim()
    ).catch(() => '');
    const clicked = await _clickNext(page);
    if (!clicked) { logger.warn('Next page tıklanamadı, durduruluyor'); break; }

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
      const base2 = new URL(page.url()).origin;
      await page.goto(base2 + '/validation-waiting-records', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 15000 });
      for (let p = 1; p < pageNum; p++) {
        await _clickNext(page);
        await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 8000 }).catch(() => {});
        await humanDelay(400, 600);
      }
    }

    await humanDelay(200, 400);
  }

  logger.info('SMS tamamlandı — gönderildi: ' + sent + ', atlandı: ' + skipped + ', hata: ' + failed);
  return { sent, skipped, failed, total: effectiveTotal };
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
