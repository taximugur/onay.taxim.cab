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
  const resend = !!(filters && filters.resend);
  const blockedRefs = resend ? new Set() : getTodayBlockedRefs();
  if (!resend && blockedRefs.size > 0) logger.info('Daha önce SMS gönderilmiş: ' + blockedRefs.size + ' ref atlanacak');
  if (resend) logger.info('Tekrar gönderim modu aktif — daha önce gönderilenler de dahil');

  let targetRefs = null;
  if (filters && filters.kayitStart && filters.kayitEnd) {
    targetRefs = getRefsByDateRange(filters.kayitStart, filters.kayitEnd);
    logger.info('DB filtresi aktif: ' + targetRefs.size + ' hedef ref (' + filters.kayitStart + ' — ' + filters.kayitEnd + ')');
  }

  // Portal date filtresi kaldırıldı — page.reload() SPA sessionStorage'ı temizliyor, session kopuyor.
  // targetRefs (DB filtresi) doğruluğu garanti eder; portal tüm kayıtları gösterir, biz DB ile filtreleriz.
  await navigateToApprovalPage(page);

  // Session kontrolü
  {
    const url = page.url();
    if (url.includes('login') || !url.includes('validation')) {
      logger.warn('Navigasyon sonrası session kopuk, kurtarma...');
      await refreshSession(page);
    }
  }

  // Tablo yüklenene bekle
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 60000 }).catch(async () => {
    const url = page.url();
    if (url.includes('login') || !url.includes('validation')) {
      await refreshSession(page);
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 }).catch(() => {});
    }
  });

  // Stabil sıralama: referansNo sütununa tıkla (re-sort drift önler)
  await _applyStableSort(page);

  const totalPages = await _getTotalPages(page);
  const portalTotal = await _getTotalCount(page);
  // effectiveTotal: hedef ref'lerden daha önce gönderilmişleri çıkar (ilerleme çubuğu doğru görünsün)
  const alreadyBlocked = targetRefs ? [...blockedRefs].filter(r => targetRefs.has(r)).length : 0;
  const effectiveTotal = targetRefs ? targetRefs.size - alreadyBlocked : portalTotal;
  logger.info('SMS tarama başladı: hedef=' + effectiveTotal + ' kayıt (DB:' + (targetRefs ? targetRefs.size : '?') + ' - gönderilmiş:' + alreadyBlocked + '), portal=' + portalTotal + ', ' + totalPages + ' sayfa');

  const processedRefs = new Set();

  pageLoop: for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (checkPauseStop) await checkPauseStop();

    await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 60000 }).catch(async () => {
      const url = page.url();
      if (url.includes('login') || !url.includes('validation')) {
        logger.warn('Sayfa başında session koptu, kurtarma...');
        await refreshSession(page);
        await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 }).catch(() => {});
      }
    });

    // Tüm satır verisini tek seferde evaluate ile oku — React re-render'dan önce snapshot
    // Bu sayede row ElementHandle stale olmaz, veri güvenilir
    const pageRowData = await page.evaluate(() => {
      const rows = document.querySelectorAll('[class*="rdt_TableRow"]');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('[class*="rdt_TableCell"]');
        return Array.from(cells).map(c => (c.textContent || '').trim());
      }).filter(cells => cells.length >= 8 && cells[0]);
    }).catch(() => []);

    for (const cells of pageRowData) {
      if (checkPauseStop) await checkPauseStop();

      const ref = cells[0];
      if (!ref || processedRefs.has(ref)) continue;

      // Non-target ref → hemen işlenmiş say, SMS gönderme
      if (targetRefs && !targetRefs.has(ref)) {
        processedRefs.add(ref);
        continue;
      }

      // Günlük limit
      if (blockedRefs.has(ref)) {
        processedRefs.add(ref);
        skipped++;
        logger.info('Daha önce gönderildi: ' + ref + ' atlandı');
        if (onProgress) onProgress({ ref, status: 'daily-limit', gonderilenSms: 0, manuelLimit: 0, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      const gonderilenSms = parseInt(cells[6] || '0') || 0;
      const manuelLimit   = parseInt(cells[7] || '0') || 0;

      if (manuelLimit > 0 && gonderilenSms >= manuelLimit) {
        processedRefs.add(ref);
        skipped++;
        logger.warn('SMS limiti dolu: ' + ref + ' (' + gonderilenSms + '/' + manuelLimit + ')');
        if (onProgress) onProgress({ ref, status: 'limit', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      // Tablo yüklenmesini bekle
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('[class*="rdt_TableRow"]').length > 0,
          { timeout: 15000 }
        );
      } catch {}

      // Satır hala bu sayfada mı? (portal SMS sonrası yeniden sıralar → satır başka sayfaya taşınmış olabilir)
      const btnState = await page.evaluate((refNo) => {
        const rows = document.querySelectorAll('[class*="rdt_TableRow"]');
        for (const row of rows) {
          const cells = row.querySelectorAll('[class*="rdt_TableCell"]');
          if (!cells[0] || cells[0].textContent.trim() !== refNo) continue;
          const btns = row.querySelectorAll('button, .btn-primary');
          return btns.length > 0 ? 'has-btn' : 'no-btn';
        }
        return 'no-row';
      }, ref).catch(() => 'no-row');

      if (btnState === 'no-row') {
        // Satır re-sort sonrası başka sayfaya taşındı — processedRefs'e EKLEME
        // İlerideki sayfalarda snapshot'a girecek ve orada işlenecek
        logger.info('Satır taşındı (re-sort): ' + ref);
        continue; // processedRefs.add YAPILMADI
      }

      // Satır bulundu → şimdi işlenmiş say
      processedRefs.add(ref);

      if (btnState === 'no-btn') {
        skipped++;
        logger.warn('SMS butonu yok: ' + ref);
        if (onProgress) onProgress({ ref, status: 'no-btn', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
        continue;
      }

      // Adım 2: Response listener kur → evaluate ile tıkla (stale handle yok)
      const responsePromise = page.waitForResponse(
        r => r.url().includes('reSendSms') || r.url().includes('sendSms'),
        { timeout: 12000 }
      ).catch(() => null);

      await page.evaluate((refNo) => {
        const rows = document.querySelectorAll('[class*="rdt_TableRow"]');
        for (const row of rows) {
          const cells = row.querySelectorAll('[class*="rdt_TableCell"]');
          if (!cells[0] || cells[0].textContent.trim() !== refNo) continue;
          const btns = row.querySelectorAll('button, .btn-primary');
          for (const btn of btns) {
            if (!btn.disabled) { btn.click(); return; }
          }
        }
      }, ref).catch(() => {});

      let success = false;
      let session401 = false;
      try {
        const response = await responsePromise;
        if (response) {
          try {
            const json = await response.json();
            if (response.status() === 401 || json.status_code === 401 || json.message === 'unauthorized') {
              session401 = true;
              logger.warn('SMS API 401 — session süresi doldu: ' + ref);
            } else {
              success = json.Success === true || json.success === true;
              if (!success) logger.warn('SMS API: ' + JSON.stringify(json));
            }
          } catch { success = response.status() === 200; }
        } else {
          success = true;
        }
      } catch(e) {
        logger.warn('SMS response hatası ' + ref + ': ' + e.message);
      }

      // 401: session expire — yeniden login, sayfa 1'den yeniden tara
      if (session401) {
        logger.warn('Session yenileniyor, sayfa 1\'den yeniden tarama başlıyor...');
        processedRefs.delete(ref); // bu ref'i yeniden dene
        await refreshSession(page);
        await _applyStableSort(page);
        pageNum = 0; // for loop increment → 1, portal da page 1'de
        break; // inner loop'tan çık → outer continue ile page 1'den devam
      }

      if (success) {
        sent++;
        await humanDelay(400, 600);
        let sonKullanimTarihi = null, yeniGonderilenSms = gonderilenSms;
        try {
          const freshData = await page.evaluate((refNo) => {
            const rows = document.querySelectorAll('[class*="rdt_TableRow"]');
            for (const row of rows) {
              const cells = row.querySelectorAll('[class*="rdt_TableCell"]');
              if (cells[0] && cells[0].textContent.trim() === refNo) {
                return {
                  gonderilenSms: cells[6] ? cells[6].textContent.trim() : '',
                  sonKullanim: cells[9] ? cells[9].textContent.trim() : ''
                };
              }
            }
            return null;
          }, ref);
          if (freshData) {
            sonKullanimTarihi = freshData.sonKullanim || null;
            yeniGonderilenSms = parseInt(freshData.gonderilenSms) || gonderilenSms;
          }
        } catch {}
        logger.info('SMS gönderildi: ' + ref + (sonKullanimTarihi ? ' | son: ' + sonKullanimTarihi : ''));
        if (onProgress) onProgress({ ref, status: 'ok', gonderilenSms: yeniGonderilenSms, manuelLimit, sonKullanimTarihi, sent, skipped, failed, total: effectiveTotal });
      } else {
        failed++;
        if (onProgress) onProgress({ ref, status: 'error', gonderilenSms, manuelLimit, sent, skipped, failed, total: effectiveTotal });
        await humanDelay(400, 700);
      }

      if (sent + skipped + failed >= effectiveTotal) break pageLoop;
    }

    if (pageNum >= totalPages) break;

    const prevRef = await page.$eval(
      '[class*="rdt_TableRow"] [class*="rdt_TableCell"]',
      el => el.textContent.trim()
    ).catch(() => '');
    const clicked = await _clickNext(page);
    if (!clicked) {
      // Pagination bulunamadı — session expire mi kontrol et
      const urlFail = page.url();
      if (urlFail.includes('login') || !urlFail.includes('validation')) {
        logger.warn('_clickNext: session koptu (sayfa ' + pageNum + '), kurtarma + sayfa 1\'den devam...');
        await refreshSession(page);
        await _applyStableSort(page);
        pageNum = 0; // increment → 1, portal page 1'de
        continue;
      }
      logger.warn('Next page tıklanamadı, durduruluyor');
      break;
    }

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
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 }).catch(() => {});
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

// Portal date filter uygula: tarih inputuna yaz → Ara → sonuçları bekle
// 18K tüm kayıt yerine sadece hedef tarih aralığını tarar (re-sort etkisi azalır)
async function _applyDateFilterToPortal(page, startISO, endISO) {
  // ISO → DD.MM.YYYY
  const fmt = iso => { const [y, m, d] = iso.split('-'); return d + '.' + m + '.' + y; };
  const startFmt = fmt(startISO); // 01.01.2025
  const endFmt   = fmt(endISO);   // 31.12.2025

  // Portal'ı temizlenmiş halde aç (reload → filtreler sıfırlanır)
  const currentUrl = page.url();
  if (!currentUrl.includes('validation-waiting-records')) {
    await navigateToApprovalPage(page);
  }
  await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
  const urlAfterReload = page.url();
  if (urlAfterReload.includes('login') || !urlAfterReload.includes('validation')) {
    await refreshSession(page);
  }
  await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 30000 }).catch(() => {});

  // Tarih input'unu bul ve doldur — Playwright fill() React synthetic event tetikler
  try {
    const dateInput = page.locator(
      'input[placeholder*="Kayıt Tarihi"], ' +
      'input[placeholder*="kayıt tarihi"], ' +
      'input[placeholder*="Tarih"], ' +
      'label:has-text("Kayıt Tarihi") + input, ' +
      'label:has-text("Kayıt Tarihi") ~ input'
    ).first();

    await dateInput.click({ timeout: 8000 });
    await humanDelay(500, 700);

    // Takvim açıldıysa eski yöntemle git
    await navigateToMonth(page, parseInt(startFmt.split('.')[1]), parseInt(startFmt.split('.')[2]));
    await humanDelay(200, 400);
    await clickDay(page, parseInt(startFmt.split('.')[0]));
    await humanDelay(400, 600);

    const [em, ey] = [parseInt(endFmt.split('.')[1]), parseInt(endFmt.split('.')[2])];
    const [sm, sy] = [parseInt(startFmt.split('.')[1]), parseInt(startFmt.split('.')[2])];
    if (em !== sm || ey !== sy) {
      await navigateToMonth(page, em, ey);
      await humanDelay(200, 400);
    }
    await clickDay(page, parseInt(endFmt.split('.')[0]));
    await humanDelay(400, 600);

    logger.info('Tarih filtresi uygulandı: ' + startFmt + ' — ' + endFmt);
  } catch(e) {
    logger.warn('Tarih filtresi uygulanamadı: ' + e.message + ' — filtresiz devam');
    return; // filtresiz devam
  }

  // Ara butonuna tıkla
  try {
    await page.locator('button:has-text("Ara")').first().click({ timeout: 5000 });
    await humanDelay(2000, 3000);
    await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 20000 }).catch(() => {});
    const filtered = await _getTotalCount(page);
    logger.info('Portal filtreli toplam: ' + filtered + ' kayıt');
  } catch(e) {
    logger.warn('"Ara" butonu hatası: ' + e.message);
  }

  // Stabil sıralama: referansNo sütununa tıkla (1. kolon)
  // Portal her SMS sonrası gonderilenSms'e göre yeniden sıralıyor → satırlar kayıyor.
  // ReferansNo'ya göre sıralarsak SMS gönderimi sıralamayı bozmaz → tüm sayfalar güvenle taranır.
  try {
    const sorted = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('[class*="rdt_TableCol"]'));
      if (headers.length === 0) return false;
      // İlk sütun (referansNo) başlığına tıkla
      const firstHeader = headers[0];
      // Tıklanabilir element bul (genellikle div içinde span ya da div)
      const clickable = firstHeader.querySelector('[role="button"], [class*="rdt_TableCol_Sortable"], div[tabindex]') || firstHeader;
      clickable.click();
      return true;
    });
    if (sorted) {
      logger.info('ReferansNo sütununa göre sıralandı (stabil sıralama)');
      await humanDelay(800, 1200);
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 10000 }).catch(() => {});
    } else {
      logger.warn('Stabil sıralama: sütun başlığı bulunamadı');
    }
  } catch(e) {
    logger.warn('Stabil sıralama hatası: ' + e.message);
  }
}

async function _applyStableSort(page) {
  try {
    await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 10000 }).catch(() => {});
    const sorted = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('[class*="rdt_TableCol"]'));
      if (headers.length === 0) return false;
      const clickable = headers[0].querySelector('[role="button"], [class*="rdt_TableCol_Sortable"], div[tabindex]') || headers[0];
      clickable.click();
      return true;
    });
    if (sorted) {
      logger.info('Stabil sıralama uygulandı (referansNo)');
      await humanDelay(800, 1200);
      await page.waitForSelector('[class*="rdt_TableRow"]', { timeout: 10000 }).catch(() => {});
    }
  } catch(e) {
    logger.warn('Stabil sıralama hatası: ' + e.message);
  }
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
    await page.waitForSelector('[class*="rdt_Pagination"] button', { timeout: 20000 });
  } catch(e) {
    logger.warn('_clickNext: pagination bekleme timeout — URL: ' + page.url());
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
