require('dotenv').config({ path: '/opt/shell-extracard-bot/.env' });
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await context.newPage();

  // Login
  await page.goto(process.env.LOGIN_URL, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"],input[type="email"],#username', process.env.USERNAME);
  await page.fill('input[type="password"]', process.env.PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle' });
  console.log('Login OK:', page.url());

  // Onay sayfasına git
  await page.click('a:has-text("Müşteri Onayı Bekleyen")');
  console.log('Menüye tıklandı, bekleniyor...');
  
  // 10 saniye bekle
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/debug1.png' });
  console.log('Screenshot: /tmp/debug1.png');

  // Sayfadaki tüm selector'leri listele
  const info = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const tbodys = document.querySelectorAll('tbody');
    const trs = document.querySelectorAll('tr');
    const divs = document.querySelectorAll('[class*="table"]');
    return {
      url: window.location.href,
      tables: tables.length,
      tbodys: tbodys.length,
      trs: trs.length,
      tableClasses: Array.from(divs).map(d => d.className).slice(0, 10),
      bodyText: document.body.innerText.substring(0, 500)
    };
  });
  console.log('Page info:', JSON.stringify(info, null, 2));

  // Daha fazla bekle
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/debug2.png' });
  console.log('Screenshot 2: /tmp/debug2.png');

  const info2 = await page.evaluate(() => ({
    tables: document.querySelectorAll('table').length,
    trs: document.querySelectorAll('tr').length,
    url: window.location.href,
    bodySnippet: document.body.innerText.substring(0, 300)
  }));
  console.log('Page info 2:', JSON.stringify(info2, null, 2));

  await browser.close();
})();
