const config = require('./config');
const logger = require('./logger');
const { humanDelay } = require('./utils');
const path = require('path');

async function login(page) {
  logger.info('Login sayfasına gidiliyor...');
  await page.goto(config.LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Screenshot al — selector'leri belirlemek için
  await page.screenshot({ path: path.join('screenshots', 'login-page.png') });
  logger.info('Screenshot: screenshots/login-page.png');

  // Yaygın login form selector'leri dene
  const userSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[placeholder*="kullanıcı" i]',
    'input[placeholder*="user" i]',
    '#username',
    '#email',
  ];

  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
  ];

  let userInput = null;
  for (const sel of userSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      userInput = sel;
      break;
    } catch {}
  }

  if (!userInput) {
    await page.screenshot({ path: path.join('screenshots', 'login-error.png') });
    throw new Error('Kullanıcı adı input bulunamadı. screenshots/login-error.png kontrol et.');
  }

  await page.fill(userInput, config.USERNAME);
  await humanDelay(300, 600);

  let passInput = null;
  for (const sel of passSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      passInput = sel;
      break;
    } catch {}
  }

  if (!passInput) throw new Error('Şifre input bulunamadı');

  await page.fill(passInput, config.PASSWORD);
  await humanDelay(300, 600);

  // Submit
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Giriş")',
    'button:has-text("Login")',
    'button:has-text("Oturum")',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      await page.click(sel, { timeout: 2000 });
      submitted = true;
      break;
    } catch {}
  }

  if (!submitted) {
    await page.keyboard.press('Enter');
  }

  // Dashboard yüklenene bekle — networkidle yerine load (SPA sürekli request yapar, networkidle timeout olur)
  await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(async () => {
    // load da gelmezse URL'e bak — portal'a ulaştıysak yeterli
    const url = page.url();
    if (!url.includes('login') && !url.includes('signin')) return; // OK
    throw new Error('Login sonrası navigasyon timeout: ' + url);
  });
  await page.screenshot({ path: path.join('screenshots', 'after-login.png') });
  logger.info('Login sonrası screenshot: screenshots/after-login.png');

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('signin')) {
    throw new Error(`Login başarısız — hala login sayfasında: ${currentUrl}`);
  }

  logger.success('Login başarılı:', currentUrl);
}

async function checkSession(page) {
  const url = page.url();
  return !url.includes('login') && !url.includes('signin');
}

async function refreshSession(page) {
  logger.warn('Session sona ermiş, yeniden login yapılıyor...');
  await login(page);

  // "Müşteri Onayı Bekleyenler" sayfasına geri git
  await navigateToApprovalPage(page);
}

async function navigateToApprovalPage(page) {
  const current = page.url();
  if (current.includes('validation-waiting-records')) return;

  // Menü tıklama — SPA içi navigasyon, auth state korunur (page.goto yapmıyoruz)
  const menuSelectors = [
    'a:has-text("Müşteri Onayı Bekleyenler")',
    'a:has-text("Müşteri Onayı Bekleyen")',
    '[href*="validation-waiting"]',
    'span:has-text("Müşteri Onayı Bekleyen")',
    'li:has-text("Müşteri Onayı Bekleyen")',
  ];

  for (const sel of menuSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel, { timeout: 3000 });
      await page.waitForURL('**/validation-waiting-records**', { timeout: 10000 });
      logger.info('Onay sayfasına gidildi (menü): ' + page.url());
      return;
    } catch {}
  }

  // Fallback: direkt URL (son çare)
  logger.warn('Menü linki bulunamadı, direkt URL deneniyor...');
  const base = new URL(config.LOGIN_URL).origin;
  await page.goto(base + '/validation-waiting-records', { waitUntil: 'networkidle', timeout: 30000 });
  logger.info('Onay sayfasına gidildi (direkt URL): ' + page.url());
}

module.exports = { login, checkSession, refreshSession, navigateToApprovalPage };
