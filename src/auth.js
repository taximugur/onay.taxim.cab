const config = require('./config');
const logger = require('./logger');
const { humanDelay } = require('./utils');

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

  // Dashboard yüklenene bekle
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
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
  // Direkt URL ile git — menü tıklamaya gerek yok
  const base = new URL(config.LOGIN_URL).origin;
  const approvalUrl = base + '/validation-waiting-records';

  const current = page.url();
  if (current.includes('validation-waiting-records')) {
    // Zaten doğru sayfadayız
    return;
  }

  await page.goto(approvalUrl, { waitUntil: 'networkidle', timeout: 30000 });
  logger.info('Onay sayfasına gidildi: ' + approvalUrl);
}

module.exports = { login, checkSession, refreshSession, navigateToApprovalPage };
