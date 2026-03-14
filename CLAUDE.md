# onay.taxim.cab — CLAUDE.md

## Proje Özeti

Shell ExtraCard Müşteri Onay Paneli. `https://extracard.turkiyeshell.com` portalındaki "Müşteri Onayı Bekleyenler" tablosunu otomatik olarak Playwright ile scrape eder, verileri SQLite'a kaydeder ve yine aynı portal üzerinden toplu SMS gönderimi yapar. Sunucu: `/opt/shell-extracard-bot/`, GitHub: `taximugur/onay.taxim.cab`.

İki ayrı web sunucusu vardır:
- **server.js** (port 8802) — eski, basit SSE tabanlı panel. Bot sürecini child_process ile spawn eder.
- **src/dashboard/server.js** (port 3333, varsayılan) — yeni, Socket.io tabanlı tam panel. `index.js` üzerinden başlatılır; Scraper ve SMS modüllerini JobManager üzerinden kontrol eder.

Aktif olan: **index.js + src/dashboard/** (yeni mimari).

## Teknik Yapı

```
index.js                    — Ana giriş: browser başlat, login yap, JobManager + Dashboard başlat
server.js                   — Eski panel (port 8802), bağımsız çalışır, index.js'i spawn eder
debug.js                    — Tek seferlik debug scripti (portal DOM inceleme)
src/
  config.js                 — .env → config objesi
  auth.js                   — login(), checkSession(), refreshSession(), navigateToApprovalPage()
  scraper.js                — scrapeAllRecords(): sayfa sayfa tablo scrape, kaldığı yerden devam modu
  sms-sender.js             — sendBulkSMS(): portal üzerinde toplu SMS gönderimi
                              applyPortalFilters(): filtre uygula + kayıt say
  db.js                     — SQLite CRUD: bulkInsert, getState, setState, logSMS, updateAfterSMS
  job-manager.js            — JobManager: startScraper(), startSMS(), pause/resume/stop
  events.js                 — EventEmitter bus (scraper ↔ dashboard arası iletişim)
  browser.js                — Playwright browser fabrikası (index.js kullanmıyor, eski referans)
  logger.js                 — chalk renkli + dosyaya yaz (logs/scrape-*.log)
  utils.js                  — humanDelay(), retry()
  excel-writer.js           — ExcelJS ile .xlsx yazıcı (util fonksiyon, direkt kullanılmıyor)
  dashboard/
    server.js               — Express + Socket.io dashboard sunucusu (port 3333)
    public/index.html       — Scraper ve SMS tabları olan tek sayfalık UI
```

## Dosyalar

| Dosya | Açıklama |
|---|---|
| `index.js` | Entry point. Chromium başlatır, login yapar, JobManager + Dashboard çalıştırır. SIGHUP yoksayar (SSH disconnect'e karşı). |
| `server.js` | Eski panel (port 8802). İçinde gömülü HTML+SSE UI var. Bot'u child process olarak spawn eder. Yakınsama (convergence) döngüsü: bot bitince eksik kayıt varsa max 8 kez yeniden başlatır. |
| `src/auth.js` | Login için çoklu selector denemesi yapar. Session kontrol: URL'de "login"/"signin" var mı. refreshSession() sonrası approval sayfasına döner. |
| `src/scraper.js` | ReactDataTable (rdt_TableRow/rdt_TableCell selector). Kaldığı sayfadan devam eder (scrape_state). Session her 50 sayfada bir kontrol. |
| `src/sms-sender.js` | Portal'da referansNo sütununa göre stabil sıralama uygular (SMS sonrası tablo yeniden sıralanıyor, satır kaymasını önler). Her SMS sonrası API response izler (reSendSms/sendSms URL pattern). 401 alırsa session yeniler. blockMode: 'all'/'today'/'none'. |
| `src/db.js` | SQLite: `data/extracard.db`. Üç tablo: records, scrape_state, sms_log. INSERT OR IGNORE ile duplicate önler. |
| `src/dashboard/server.js` | Socket.io event'leri JobManager'a iletir. /api/state ve /api/excel endpoint'leri. |
| `src/dashboard/public/index.html` | Scraper tab + SMS tab. Socket.io ile gerçek zamanlı log ve progress. Yeniden bağlanınca son SMS progress'i yükler. |

## Servisler / Deploy

**Sunucu:** `/opt/shell-extracard-bot/` (GCP instance veya ayrı VM — teyit edilmeli)

**Servis adı (tahmini):** `shell-extracard-bot.service`

**Başlatma:**
```bash
# Yeni mimari (dashboard port 3333)
node index.js

# Eski panel (port 8802, bot'u spawn eder)
node server.js
```

**Port haritası:**
| Port | Servis |
|------|--------|
| 3333 | Dashboard (Socket.io) — index.js yoluyla |
| 8802 | Eski panel (server.js) |

**Env dosyası:** `.env` (runtime'da server.js tarafından yeniden oluşturulur her bot başlatmada)

**Kritik env değerleri:**
```
LOGIN_URL=https://extracard.turkiyeshell.com
USERNAME=uakkus@bilisim-inovasyon.com.tr
PASSWORD=Shell2023!
HEADLESS=true
ROWS_PER_PAGE=30
DELAY_BETWEEN_PAGES_MS=200
MAX_RETRY=3
SESSION_CHECK_EVERY=50
DASHBOARD_PORT=3333   (opsiyonel, varsayılan 3333)
```

**Deploy akışı:**
1. Lokal değişiklik yap
2. `bash ~/clawd/sync_repos.sh` ile sunucuya deploy et
3. Sunucuda servisi yeniden başlat
4. GitHub'a push et

## DB / Veri

**Dosya:** `data/extracard.db` (SQLite, .gitignore'da)

### Tablolar

**records** — Scrape edilen müşteri kayıtları
```sql
id, referansNo (UNIQUE), isim, soyisim, kartNo, gsm, plaka,
gonderilenSms, manuelSmsLimiti,
kayitTarihi (DD.MM.YYYY HH:MM:SS), kayitTarihi_iso (YYYY-MM-DD),
sonKullanimTarihi, sonKullanimiIso,
scrapedAt
```
Index: `idx_kayit_iso` (kayitTarihi_iso), `idx_son_iso` (sonKullanimiIso)

**scrape_state** — Scraper durumu (tek satır, id=1)
```sql
id=1, lastPage, totalPages, rowsPerPage, totalRecords, lastRun, status
```
status değerleri: `idle` / `running` / `done`

**sms_log** — Her SMS girişimi kaydı
```sql
id, referansNo, tarih, durum (ok/limit/daily-limit/no-btn/error),
gonderilenSms, manuelLimit, sonKullanimTarihi, hata
```

### Önemli Sorgular

```sql
-- Toplam kayıt
SELECT COUNT(*) FROM records;

-- Bugün gönderilen SMS'ler
SELECT COUNT(*) FROM sms_log WHERE durum='ok' AND date(tarih)=date('now','localtime');

-- Tarih aralığında kayıtlar
SELECT * FROM records WHERE kayitTarihi_iso BETWEEN '2025-01-01' AND '2025-03-31';
```

## Önemli Notlar

### Portal Özellikleri
- **SPA (React):** `page.goto()` yerine menüye tıklayarak navigasyon yapılır. `page.reload()` oturum açmayı tetikler — kullanılmamalı (sms-sender'da eski `_applyDateFilterToPortal` fonksiyonu bu yüzden terk edildi).
- **ReactDataTable:** Tablo selector'ları `rdt_TableRow`, `rdt_TableCell`, `rdt_Pagination`.
- **Tarih filtresi:** Flatpickr kullanılıyor. `select.flatpickr-monthDropdown-months` + `input.flatpickr-year` ile navigasyon, `span.flatpickr-day` ile gün seçimi.
- **SMS sonrası yeniden sıralama:** Portal her SMS gönderiminden sonra tabloyu yeniden sıralar. Bu yüzden SMS modülü referansNo'ya göre stabil sıralama uygular (`_applyStableSort`). Satır bulunamazsa "no-row" döner ve processedRefs'e eklenmez — sonraki sayfalarda bulunur.
- **Session yönetimi:** Her 50 sayfada kontrol, 401 response alınca otomatik refresh, URL "login" içeriyorsa kurtarma modu.

### SMS Blok Modları
| blockMode | Davranış |
|-----------|----------|
| `all` (varsayılan) | Daha önce hiç gönderilmemiş olanlara gönder |
| `today` | Bugün gönderilenleri atla |
| `none` | Herkese gönder (limitsiz) |

### Anti-Detection
- `navigator.webdriver = false` inject
- `tr-TR` locale, `Europe/Istanbul` timezone
- `Mozilla/5.0 Windows Chrome/121` user-agent
- `humanDelay()` ile rastgele gecikmeler (200–1500ms arası)

### Yakınsama (Convergence) — server.js'de
Eski panel (server.js): bot başarıyla bitip portal toplam kayıt sayısından 30'dan fazla eksik varsa max 8 kez otomatik yeniden başlatır. Yeni mimaride (index.js) bu mekanizma yok; scraper manuel başlatılır.

### Logs
`logs/scrape-YYYY-MM-DDTHH-MM-SS.log` — her çalıştırmada yeni dosya oluşur. `.gitignore`'da.

### Screenshots
`screenshots/login-page.png`, `screenshots/after-login.png`, `screenshots/filter-*.png` — debug için auth ve filtre adımlarında otomatik alınır. `.gitignore`'da.

### Dikkat Edilmesi Gerekenler
- `data/` klasörü `.gitignore`'da — production DB'si asla commit edilmez.
- `src/scraper-reverse.js` de `.gitignore`'da (ters sıralama denemesi, terk edildi).
- `server.js` standalone çalışır ama `index.js` ile eş zamanlı çalıştırılmamalı (aynı DB'ye erişir, port çakışmaz ama bot process karışabilir).
- `.env` runtime'da server.js tarafından üretilir; elle düzenleme yapılırsa server.js bir sonraki bot başlatmada üzerine yazar.
